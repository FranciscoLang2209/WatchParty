import type { Match } from '@/features/matches/types';
import type { TeamOption } from '@/features/profiles/types';

export interface FavoriteMatchInput {
  favoriteTeamId: string | null;
  /** Directorio de equipos: traduce el id del favorito al nombre que usa el catálogo. */
  teams: readonly TeamOption[];
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
 * El contrato de partidos trae nombres de equipo, no ids: el favorito se
 * relaciona por el nombre que le asigna el directorio de equipos. Es pura: sin
 * I/O y sin modificar sus argumentos.
 */
export function findFavoriteMatch({
  favoriteTeamId,
  teams,
  matches,
  now,
}: FavoriteMatchInput): Match | null {
  if (favoriteTeamId === null) return null;

  const favorite = teams.find((team) => team.id === favoriteTeamId);
  if (favorite === undefined) return null;

  const favoriteMatches = matches.filter(
    (match) => match.homeTeam === favorite.name || match.awayTeam === favorite.name,
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
