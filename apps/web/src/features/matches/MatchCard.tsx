import { Link } from 'react-router-dom';
import { Card } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import { formatKickoff, matchStatusLabel } from './format';
import type { Match } from './types';

interface MatchCardProps {
  match: Match;
}

/**
 * Tarjeta de un partido en el listado.
 *
 * No usa `CardTitle` a propósito: ese primitive renderiza un `<h1>` y la Home
 * debe conservar uno solo.
 */
export function MatchCard({ match }: MatchCardProps) {
  const enVivo = match.status === 'live';

  return (
    <Card className="gap-3 p-4">
      {/* `min-w-0` y el quiebre de palabra evitan que un nombre largo desborde. */}
      <h2 className="min-w-0 text-base leading-snug font-semibold break-words">
        {match.homeTeam} <span className="text-muted-foreground">vs.</span> {match.awayTeam}
      </h2>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 text-sm text-muted-foreground">{formatKickoff(match.kickoffAt)}</p>

        <span
          className={cn(
            'rounded-sm px-2 py-1 text-xs font-semibold',
            // El rojo del sistema se reserva para LIVE; el resto usa el fondo sutil.
            enVivo ? 'bg-live/10 text-live' : 'bg-muted text-muted-foreground',
          )}
        >
          {matchStatusLabel(match.status)}
        </span>
      </div>

      <Link
        to={`/matches/${match.id}`}
        aria-label={`Ver partido: ${match.homeTeam} vs. ${match.awayTeam}`}
        className="rounded-sm text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Ver partido
      </Link>
    </Card>
  );
}
