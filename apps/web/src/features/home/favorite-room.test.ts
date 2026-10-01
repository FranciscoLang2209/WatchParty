import { describe, expect, it } from 'vitest';
import type { Match } from '@/features/matches/types';
import { findFavoriteMatch } from './favorite-room';

const NOW = new Date('2026-09-24T18:00:00Z');

function match(overrides: Partial<Match> & Pick<Match, 'id'>): Match {
  return {
    homeTeam: 'River Plate',
    homeTeamId: 'team-river',
    awayTeam: 'Boca Juniors',
    awayTeamId: 'team-boca',
    kickoffAt: '2026-09-24T20:00:00Z',
    status: 'scheduled',
    ...overrides,
  };
}

describe('findFavoriteMatch', () => {
  it('devuelve null sin equipo favorito', () => {
    const matches = [match({ id: 'm1', status: 'live' })];

    expect(findFavoriteMatch({ favoriteTeamId: null, matches, now: NOW })).toBeNull();
  });

  it('devuelve null si el favorito no juega ningún partido del catálogo', () => {
    const matches = [match({ id: 'm1', status: 'live' })];

    expect(findFavoriteMatch({ favoriteTeamId: 'team-racing', matches, now: NOW })).toBeNull();
  });

  it('prefiere el partido en vivo del favorito sobre uno programado', () => {
    const scheduled = match({ id: 'm1', kickoffAt: '2026-09-24T19:00:00Z' });
    const live = match({
      id: 'm2',
      homeTeam: 'Racing Club',
      homeTeamId: 'team-racing',
      awayTeam: 'River Plate',
      awayTeamId: 'team-river',
      kickoffAt: '2026-09-24T17:30:00Z',
      status: 'live',
    });

    const result = findFavoriteMatch({
      favoriteTeamId: 'team-river',
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
      matches: [later, earlier],
      now: NOW,
    });

    expect(result).toBe(earlier);
  });

  it('sin partido en vivo devuelve el programado futuro más cercano', () => {
    const past = match({ id: 'm1', kickoffAt: '2026-09-24T17:00:00Z' });
    const far = match({ id: 'm2', kickoffAt: '2026-09-30T20:00:00Z' });
    const next = match({
      id: 'm3',
      awayTeam: 'Racing Club',
      awayTeamId: 'team-racing',
      kickoffAt: '2026-09-25T20:00:00Z',
    });

    const result = findFavoriteMatch({
      favoriteTeamId: 'team-river',
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
      match({
        id: 'm4',
        homeTeam: 'Racing Club',
        homeTeamId: 'team-racing',
        status: 'live',
      }),
    ];

    expect(findFavoriteMatch({ favoriteTeamId: 'team-river', matches, now: NOW })).toBeNull();
  });

  it('no toma como propio el partido de un equipo homónimo del favorito', () => {
    // `teams.name` no es único: el homónimo comparte nombre pero no id.
    const homonymMatch = match({ id: 'm1', homeTeamId: 'team-river-homonimo', status: 'live' });
    const ownMatch = match({ id: 'm2', kickoffAt: '2026-09-25T20:00:00Z' });

    const result = findFavoriteMatch({
      favoriteTeamId: 'team-river',
      matches: [homonymMatch, ownMatch],
      now: NOW,
    });

    expect(result).toBe(ownMatch);
  });

  it('es determinista y no modifica sus argumentos', () => {
    const matches = [
      match({ id: 'm1', kickoffAt: '2026-09-26T20:00:00Z' }),
      match({ id: 'm2', kickoffAt: '2026-09-25T20:00:00Z' }),
    ];
    const now = new Date(NOW);
    const snapshot = structuredClone({ matches, now });
    const input = { favoriteTeamId: 'team-river', matches, now };

    const first = findFavoriteMatch(input);
    const second = findFavoriteMatch(input);

    expect(first).toBe(matches[1]);
    expect(second).toBe(first);
    expect({ matches, now }).toEqual(snapshot);
  });
});
