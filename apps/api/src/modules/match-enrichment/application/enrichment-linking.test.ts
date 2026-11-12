import { describe, it, expect } from 'vitest';
import type { EnrichmentMatchRef } from '../domain/match-enrichment.js';
import type { FixtureInfo } from './api-football-enrichment-normalizer.js';
import { teamNamesCompatible, verifyCorrespondence } from './enrichment-linking.js';

const MATCH: EnrichmentMatchRef = {
  id: 'match-1',
  provider: 'football-data-org',
  status: 'finished',
  kickoffAt: '2024-07-14T19:00:00.000Z',
  homeTeamName: 'Spain',
  awayTeamName: 'England',
  competitionExternalId: '2018', // Eurocopa en football-data.org
  score: { home: 2, away: 1 },
};

const FIXTURE: FixtureInfo = {
  fixtureId: 1145512,
  kickoffAt: '2024-07-14T19:00:00.000Z',
  leagueId: 4,
  leagueName: 'Euro Championship',
  season: 2024,
  statusShort: 'FT',
  home: { id: 9, name: 'Spain' },
  away: { id: 10, name: 'England' },
  goals: { home: 2, away: 1 },
  embeddedStatistics: null,
  embeddedEvents: null,
};

function codes(match: EnrichmentMatchRef, fixture: FixtureInfo): string[] {
  const verdict = verifyCorrespondence(match, fixture);
  return verdict.accepted ? [] : verdict.rejections.map((r) => r.code);
}

describe('teamNamesCompatible', () => {
  it.each([
    ['Spain', 'Spain'],
    ['Manchester City FC', 'Manchester City'],
    ['AFC Bournemouth', 'Bournemouth'],
    ['Brighton & Hove Albion FC', 'Brighton'],
    ['Atlético Madrid', 'Atletico Madrid'],
  ])('%s ≈ %s', (a, b) => {
    expect(teamNamesCompatible(a, b)).toBe(true);
    expect(teamNamesCompatible(b, a)).toBe(true);
  });

  it.each([
    ['Manchester City', 'Manchester United'],
    ['Real Madrid', 'Real Sociedad'],
    ['Spain', 'England'],
    ['', 'Spain'],
  ])('%s ≠ %s (compartir una palabra no alcanza)', (a, b) => {
    expect(teamNamesCompatible(a, b)).toBe(false);
  });
});

describe('verifyCorrespondence', () => {
  it('acepta un partido que coincide en competición, fecha, equipos, orientación y marcador', () => {
    expect(verifyCorrespondence(MATCH, FIXTURE)).toEqual({ accepted: true, notes: [] });
  });

  it('acepta una pequeña diferencia de horario entre proveedores', () => {
    expect(codes(MATCH, { ...FIXTURE, kickoffAt: '2024-07-14T19:15:00.000Z' })).toEqual([]);
  });

  it('rechaza una reprogramación o un partido de otra fecha', () => {
    expect(codes(MATCH, { ...FIXTURE, kickoffAt: '2024-07-15T19:00:00.000Z' })).toEqual([
      'fecha-distinta',
    ]);
    expect(codes(MATCH, { ...FIXTURE, kickoffAt: '2024-07-14T21:00:00.000Z' })).toEqual([
      'fecha-distinta',
    ]);
  });

  it('rechaza equipos distintos aunque la fecha coincida', () => {
    expect(codes(MATCH, { ...FIXTURE, home: { id: 1, name: 'France' } })).toEqual([
      'equipos-distintos',
    ]);
  });

  it('rechaza la orientación local/visitante invertida', () => {
    const invertido = {
      ...FIXTURE,
      home: { id: 10, name: 'England' },
      away: { id: 9, name: 'Spain' },
      goals: { home: 1, away: 2 },
    };

    expect(codes(MATCH, invertido)).toContain('orientacion-invertida');
  });

  it('rechaza otra competición y una competición sin equivalente conocido', () => {
    expect(codes(MATCH, { ...FIXTURE, leagueId: 39 })).toEqual(['competicion-distinta']);
    expect(codes({ ...MATCH, competitionExternalId: '9999' }, FIXTURE)).toEqual([
      'competicion-sin-equivalente',
    ]);
  });

  it('rechaza un marcador distinto', () => {
    expect(codes(MATCH, { ...FIXTURE, goals: { home: 3, away: 1 } })).toEqual([
      'marcador-distinto',
    ]);
  });

  it('no compara el marcador tras una tanda de penales (los proveedores no coinciden en incluirla)', () => {
    const verdict = verifyCorrespondence(MATCH, {
      ...FIXTURE,
      statusShort: 'PEN',
      goals: { home: 0, away: 0 },
    });

    expect(verdict).toMatchObject({ accepted: true });
    expect(verdict.accepted && verdict.notes.join()).toContain('penales');
  });

  it('con marcador ausente en alguno de los dos lo avisa pero no rechaza', () => {
    const verdict = verifyCorrespondence({ ...MATCH, score: null }, FIXTURE);

    expect(verdict).toMatchObject({ accepted: true });
    expect(verdict.accepted && verdict.notes.join()).toContain('no comparado');
  });

  it('exige que el partido interno venga de football-data.org: otro proveedor se rechaza explícitamente', () => {
    expect(codes({ ...MATCH, provider: 'api-football' }, FIXTURE)).toEqual([
      'proveedor-no-soportado',
    ]);
    expect(codes({ ...MATCH, provider: 'local-fixtures' }, FIXTURE)).toEqual([
      'proveedor-no-soportado',
    ]);
  });

  it('rechaza un partido interno no finalizado o un fixture que no terminó', () => {
    expect(codes({ ...MATCH, status: 'scheduled' }, FIXTURE)).toEqual(['partido-no-finalizado']);
    expect(codes(MATCH, { ...FIXTURE, statusShort: 'NS' })).toEqual(['fixture-no-finalizado']);
    expect(codes(MATCH, { ...FIXTURE, statusShort: 'PST' })).toEqual(['fixture-no-finalizado']);
  });

  it('informa todos los motivos juntos', () => {
    expect(
      codes(
        { ...MATCH, status: 'live' },
        { ...FIXTURE, leagueId: 39, kickoffAt: '2024-08-01T19:00:00.000Z' },
      ),
    ).toEqual(['partido-no-finalizado', 'competicion-distinta', 'fecha-distinta']);
  });
});
