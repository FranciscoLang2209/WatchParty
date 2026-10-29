import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getMatch } from '@/features/matches/api';
import { formatKickoff, matchStatusLabel } from '@/features/matches/format';
import { MatchResult } from '@/features/matches/MatchResult';
import { isCancelled, isUnauthorized, type Match } from '@/features/matches/types';
import { cn } from '@/lib/utils';

export interface RoomMatchHeaderProps {
  matchId: string;
  accessToken: string;
}

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; match: Match }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_ERROR = 'No pudimos cargar los datos del partido.';

/** El texto del estado siempre se muestra; el estilo sólo lo refuerza. */
const ESTILO_ESTADO: Record<Match['status'], string> = {
  // El rojo del sistema se reserva para LIVE.
  live: 'bg-live/10 text-live',
  finished: 'border border-border bg-card text-foreground',
  scheduled: 'bg-muted text-muted-foreground',
  postponed: 'border border-dashed border-border bg-muted text-muted-foreground',
  cancelled: 'border border-dashed border-border bg-muted text-muted-foreground',
};

/**
 * Presentación propia de la sala (la tarjeta global del listado no se toca).
 * Sigue el orden de lectura del sistema de diseño: estado → equipos →
 * marcador o, sin resultado, horario → enlace al detalle.
 */
function PartidoDeLaSala({ match }: { match: Match }) {
  const titulo = `${match.homeTeam} vs. ${match.awayTeam}`;

  return (
    <Card className="gap-3 p-4">
      <div className="flex">
        <span
          className={cn('rounded-sm px-2 py-1 text-xs font-semibold', ESTILO_ESTADO[match.status])}
        >
          {matchStatusLabel(match.status)}
        </span>
      </div>

      {/* `min-w-0` y el quiebre de palabra evitan que un nombre largo desborde. */}
      <h2 className="min-w-0 text-base leading-snug font-semibold break-words">
        {match.homeTeam} <span className="text-muted-foreground">vs.</span> {match.awayTeam}
      </h2>

      {match.score ? (
        <>
          <MatchResult match={match} className="text-3xl" />
          <p className="min-w-0 text-sm text-muted-foreground">{formatKickoff(match.kickoffAt)}</p>
        </>
      ) : (
        <p className="min-w-0 font-display text-2xl leading-tight font-semibold">
          {formatKickoff(match.kickoffAt)}
        </p>
      )}

      <Link
        to={`/matches/${match.id}`}
        aria-label={`Ver partido: ${titulo}`}
        className="inline-flex min-h-11 items-center self-start rounded-sm text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Ver partido
      </Link>
    </Card>
  );
}

/**
 * Encabezado de la sala: el partido al que pertenece, con estado, equipos,
 * marcador u horario local y enlace al detalle.
 *
 * Carga el partido por su cuenta: si falla, el reintento es sólo suyo y la
 * sala, los comentarios y el formulario siguen montados. La sesión vencida no
 * ofrece reintento acá; el reingreso lo ofrece la lista de comentarios.
 */
export function RoomMatchHeader({ matchId, accessToken }: RoomMatchHeaderProps) {
  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let vigente = true;

    getMatch(matchId, accessToken, controller.signal)
      .then((match) => {
        if (vigente) setEstado({ status: 'ready', match });
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje o cambio de sala no se anuncia.
        if (!vigente || isCancelled(error)) return;

        setEstado(
          isUnauthorized(error)
            ? { status: 'error', message: (error as Error).message, expired: true }
            : { status: 'error', message: MENSAJE_ERROR, expired: false },
        );
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [matchId, accessToken, intento]);

  const reintentar = useCallback(() => {
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  if (estado.status === 'loading') {
    return <p className="text-sm text-muted-foreground">Cargando el partido…</p>;
  }

  if (estado.status === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">{estado.message}</p>

        {estado.expired ? null : (
          <Button
            type="button"
            variant="outline"
            aria-label="Reintentar la carga del partido"
            onClick={reintentar}
          >
            Reintentar
          </Button>
        )}
      </div>
    );
  }

  return <PartidoDeLaSala match={estado.match} />;
}
