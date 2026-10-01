import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MatchCard } from '@/features/matches/MatchCard';
import { getMatch } from '@/features/matches/api';
import { isCancelled, isUnauthorized, type Match } from '@/features/matches/types';

export interface RoomMatchHeaderProps {
  matchId: string;
  accessToken: string;
}

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; match: Match }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_ERROR = 'No pudimos cargar los datos del partido.';

/**
 * Encabezado de la sala: el partido al que pertenece, con equipos, horario
 * local, estado y enlace al detalle (los mismos que la tarjeta del listado).
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

  return <MatchCard match={estado.match} />;
}
