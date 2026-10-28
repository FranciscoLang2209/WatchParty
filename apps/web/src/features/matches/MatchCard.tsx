import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import { formatKickoff, matchStatusLabel } from './format';
import type { Match } from './types';

interface MatchCardProps {
  match: Match;
  /**
   * `directory` es la presentación del directorio de salas. Cualquier otra
   * pantalla usa `default`: los estilos del directorio no se filtran a ella.
   */
  variant?: 'default' | 'directory';
}

function EstadoBadge({ status }: { status: Match['status'] }) {
  return (
    <span
      className={cn(
        'rounded-sm px-2 py-1 text-xs font-semibold',
        // El rojo del sistema se reserva para LIVE; el resto usa el fondo sutil.
        status === 'live' ? 'bg-live/10 text-live' : 'bg-muted text-muted-foreground',
      )}
    >
      {matchStatusLabel(status)}
    </span>
  );
}

/**
 * Tarjeta del directorio de salas. Sigue el orden de lectura del sistema de
 * diseño (estado → equipos → horario → acción) y la acción es el mismo enlace al
 * detalle, con aspecto de botón para que se reconozca y tenga un área táctil
 * de 44 px. El `h-full` y el `mt-auto` alinean los enlaces de una misma fila.
 */
function DirectoryMatchCard({ match }: { match: Match }) {
  return (
    <Card className="h-full gap-4 p-4 sm:p-5">
      <div className="flex">
        <EstadoBadge status={match.status} />
      </div>

      <h2 className="min-w-0 font-display text-lg leading-snug font-semibold break-words">
        {match.homeTeam} <span className="font-normal text-muted-foreground">vs.</span>{' '}
        {match.awayTeam}
      </h2>

      <p className="min-w-0 text-sm text-muted-foreground">{formatKickoff(match.kickoffAt)}</p>

      <Button asChild variant="outline" className="mt-auto w-full">
        <Link
          to={`/matches/${match.id}`}
          aria-label={`Ver partido: ${match.homeTeam} vs. ${match.awayTeam}`}
        >
          Ver partido
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </Card>
  );
}

/**
 * Tarjeta de un partido en el listado.
 *
 * No usa `CardTitle` a propósito: ese primitive renderiza un `<h1>` y la Home
 * debe conservar uno solo.
 */
export function MatchCard({ match, variant = 'default' }: MatchCardProps) {
  if (variant === 'directory') {
    return <DirectoryMatchCard match={match} />;
  }

  return (
    <Card className="gap-3 p-4">
      {/* `min-w-0` y el quiebre de palabra evitan que un nombre largo desborde. */}
      <h2 className="min-w-0 text-base leading-snug font-semibold break-words">
        {match.homeTeam} <span className="text-muted-foreground">vs.</span> {match.awayTeam}
      </h2>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 text-sm text-muted-foreground">{formatKickoff(match.kickoffAt)}</p>

        <EstadoBadge status={match.status} />
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
