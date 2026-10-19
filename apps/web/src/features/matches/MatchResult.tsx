import { cn } from '../../lib/utils';
import type { Match } from './types';

interface MatchResultProps {
  match: Pick<Match, 'homeTeam' | 'awayTeam' | 'score'>;
  className?: string;
}

const SIN_RESULTADO = 'Sin resultado';

/**
 * Marcador real del partido (WAT-230), compartido por el detalle y el
 * historial. Sin marcador se dice explícitamente: nunca se muestra un 0–0 que
 * el proveedor no confirmó. El estado del partido se muestra aparte.
 */
export function MatchResult({ match, className }: MatchResultProps) {
  if (!match.score) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{SIN_RESULTADO}</p>;
  }

  const { home, away } = match.score;

  return (
    <p className={cn('font-display text-2xl leading-none font-semibold', className)}>
      {/* El lector de pantalla oye cada gol con su equipo, no «2 guion 1». */}
      <span className="sr-only">
        Resultado: {match.homeTeam} {home}, {match.awayTeam} {away}
      </span>
      <span aria-hidden="true" className="tabular-nums">
        {home} – {away}
      </span>
    </p>
  );
}
