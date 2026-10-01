import type { Match } from '@/features/matches/types';

export interface FavoriteMatchInput {
  favoriteTeamId: string | null;
  matches: readonly Match[];
  /** Hora actual inyectada: la función no lee el reloj para ser determinista. */
  now: Date;
}

function kickoffTime(match: Match): number {
  return Date.parse(match.kickoffAt);
}

function earliest(matches: Match[]): Match | null {
  return matches.reduce<Match | null>(
    (best, match) => (best === null || kickoffTime(match) < kickoffTime(best) ? match : best),
    null,
  );
}

/**
 * Elige el único partido del favorito que vale la pena destacar: el `live` de
 * inicio más temprano o, si no hay, el `scheduled` más cercano que todavía no
 * empezó. En cualquier otro caso, `null`.
 *
 * El favorito se relaciona por id y no por nombre, porque `teams.name` no es
 * único. Es pura: sin I/O y sin modificar sus argumentos.
 */
export function findFavoriteMatch({
  favoriteTeamId,
  matches,
  now,
}: FavoriteMatchInput): Match | null {
  if (favoriteTeamId === null) return null;

  const favoriteMatches = matches.filter(
    (match) => match.homeTeamId === favoriteTeamId || match.awayTeamId === favoriteTeamId,
  );

  const live = earliest(favoriteMatches.filter((match) => match.status === 'live'));
  if (live !== null) return live;

  const nowTime = now.getTime();
  return earliest(
    favoriteMatches.filter(
      (match) => match.status === 'scheduled' && kickoffTime(match) >= nowTime,
    ),
  );
}
