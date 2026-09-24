import { describe, expect, it } from 'vitest';
import type { Match } from '@/features/matches/types';
import type { TeamOption } from '@/features/profiles/types';
import { findFavoriteMatch } from './favorite-room';

const NOW = new Date('2026-09-24T18:00:00Z');

const TEAMS: TeamOption[] = [
  { id: 'team-river', name: 'River Plate' },
  { id: 'team-boca', name: 'Boca Juniors' },
  { id: 'team-racing', name: 'Racing Club' },
];

function match(overrides: Partial<Match> & Pick<Match, 'id'>): Match {
  return {
    homeTeam: 'River Plate',
    awayTeam: 'Boca Juniors',
    kickoffAt: '2026-09-24T20:00:00Z',
    status: 'scheduled',
    ...overrides,
  };
}

describe('findFavoriteMatch', () => {
  it('devuelve null sin equipo favorito', () => {
    const matches = [match({ id: 'm1', status: 'live' })];

    expect(findFavoriteMatch({ favoriteTeamId: null, teams: TEAMS, matches, now: NOW })).toBeNull();
  });

  it('devuelve null si el favorito no está en el directorio de equipos', () => {
    const matches = [match({ id: 'm1', status: 'live' })];

    expect(
      findFavoriteMatch({ favoriteTeamId: 'team-desconocido', teams: TEAMS, matches, now: NOW }),
    ).toBeNull();
  });

  it('prefiere el partido en vivo del favorito sobre uno programado', () => {
    const scheduled = match({ id: 'm1', kickoffAt: '2026-09-24T19:00:00Z' });
    const live = match({
      id: 'm2',
      homeTeam: 'Racing Club',
      awayTeam: 'River Plate',
      kickoffAt: '2026-09-24T17:30:00Z',
      status: 'live',
    });

    const result = findFavoriteMatch({
      favoriteTeamId: 'team-river',
      teams: TEAMS,
      matches: [scheduled, live],
      now: NOW,
    });

    expect(result).toBe(live);
  });

  it('entre varios en vivo elige el de inicio más temprano', () => {
    const later = match({ id: 'm1', kickoffAt: '2026-09-24T17:45:00Z', status: 'live' });
    const earlier = match({ id: 'm2', kickoffAt: '2026-09-24T17:00:00Z', status: 'live' });

    const result = findFavoriteMatch({
      favoriteTeamId: 'team-boca',
      teams: TEAMS,
      matches: [later, earlier],
      now: NOW,
    });

    expect(result).toBe(earlier);
  });

  it('sin partido en vivo devuelve el programado futuro más cercano', () => {
    const past = match({ id: 'm1', kickoffAt: '2026-09-24T17:00:00Z' });
    const far = match({ id: 'm2', kickoffAt: '2026-09-30T20:00:00Z' });
    const next = match({ id: 'm3', awayTeam: 'Racing Club', kickoffAt: '2026-09-25T20:00:00Z' });

    const result = findFavoriteMatch({
      favoriteTeamId: 'team-river',
      teams: TEAMS,
      matches: [far, past, next],
      now: NOW,
    });

    expect(result).toBe(next);
  });

  it('no devuelve partidos terminados, cancelados, postergados ni de otros equipos', () => {
    const matches = [
      match({ id: 'm1', status: 'finished', kickoffAt: '2026-09-24T15:00:00Z' }),
      match({ id: 'm2', status: 'cancelled' }),
      match({ id: 'm3', status: 'postponed' }),
      match({ id: 'm4', homeTeam: 'Racing Club', awayTeam: 'Boca Juniors', status: 'live' }),
    ];

    expect(
      findFavoriteMatch({ favoriteTeamId: 'team-river', teams: TEAMS, matches, now: NOW }),
    ).toBeNull();
  });

  it('es determinista y no modifica sus argumentos', () => {
    const matches = [
      match({ id: 'm1', kickoffAt: '2026-09-26T20:00:00Z' }),
      match({ id: 'm2', kickoffAt: '2026-09-25T20:00:00Z' }),
    ];
    const teams = [...TEAMS];
    const now = new Date(NOW);
    const snapshot = structuredClone({ matches, teams, now });
    const input = { favoriteTeamId: 'team-river', teams, matches, now };

    const first = findFavoriteMatch(input);
    const second = findFavoriteMatch(input);

    expect(first).toBe(matches[1]);
    expect(second).toBe(first);
    expect({ matches, teams, now }).toEqual(snapshot);
  });
});
