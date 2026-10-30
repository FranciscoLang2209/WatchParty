import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatKickoff, matchStatusLabel } from './format';
import { MatchResult } from './MatchResult';
import type { Match } from './types';

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
 * Resumen de un partido para las pantallas que lo muestran con su resultado
 * (encabezado de la sala y resultados de búsqueda). Es aparte de `MatchCard`,
 * la tarjeta del listado, que no se toca.
 *
 * Sigue el orden de lectura del sistema de diseño: estado → equipos → marcador
 * o, sin resultado, horario → enlace al detalle. El título es un `h2`: cuelga
 * del `h1` de la pantalla que lo usa.
 */
export function MatchSummaryCard({ match }: { match: Match }) {
  const titulo = `${match.homeTeam} vs. ${match.awayTeam}`;

  return (
    <Card className="h-full gap-3 p-4">
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

      {/* El enlace baja al pie para alinear las acciones de una misma fila. */}
      <Link
        to={`/matches/${match.id}`}
        aria-label={`Ver partido: ${titulo}`}
        className="mt-auto inline-flex min-h-11 items-center self-start rounded-sm text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Ver partido
      </Link>
    </Card>
  );
}
