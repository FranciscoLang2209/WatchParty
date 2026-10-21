import { describe, it, expect } from 'vitest';
import { normalizeFootballDataOrgMatches } from './football-data-org-normalizer.js';
import type { FootballDataOrgFetchOutcome } from '../infrastructure/football-data-org-client.js';

function successOutcome(body: unknown): FootballDataOrgFetchOutcome {
  return { kind: 'response', status: 200, ok: true, body, headers: {} };
}

// Mismo partido sanitizado que docs/integrations/football-data-org-coverage.md.
const VALID_MATCH = {
  id: 560593,
  utcDate: '2026-10-10T11:30:00Z',
  status: 'TIMED',
  competition: { id: 2021, code: 'PL', name: 'Premier League' },
  season: { id: 2502, startDate: '2026-08-21', endDate: '2027-05-30' },
  homeTeam: { id: 57, name: 'Arsenal FC' },
  awayTeam: { id: 341, name: 'Leeds United FC' },
  // Forma real de un partido sin jugar (verificada el 19/10/2026).
  score: {
    winner: null,
    duration: 'REGULAR',
    fullTime: { home: null, away: null },
    halfTime: { home: null, away: null },
  },
};

// Forma real de un partido jugado (Everton 0–2 Chelsea, 17/10/2026).
function playedMatch(home: unknown, away: unknown) {
  return {
    ...VALID_MATCH,
    status: 'FINISHED',
    score: {
      winner: 'AWAY_TEAM',
      duration: 'REGULAR',
      fullTime: { home, away },
      halfTime: { home: 0, away: 0 },
    },
  };
}

function firstScore(rawMatch: unknown) {
  const result = normalizeFootballDataOrgMatches(successOutcome({ matches: [rawMatch] }));
  if (result.kind !== 'success' || result.fixtures.length !== 1) {
    throw new Error('Se esperaba exactamente un fixture normalizado.');
  }
  return result.fixtures[0]!.score;
}

describe('normalizeFootballDataOrgMatches', () => {
  it('normaliza un partido válido con fecha ISO UTC y estado mapeado', () => {
    const result = normalizeFootballDataOrgMatches(successOutcome({ matches: [VALID_MATCH] }));

    expect(result).toEqual({
      kind: 'success',
      fixtures: [
        {
          provider: 'football-data-org',
          externalId: '560593',
          homeTeam: { externalId: '57', name: 'Arsenal FC' },
          awayTeam: { externalId: '341', name: 'Leeds United FC' },
          competitionExternalId: '2021',
          season: '2502',
          kickoffAt: '2026-10-10T11:30:00.000Z',
          status: 'scheduled',
          score: null,
        },
      ],
      skipped: [],
    });
  });

  it('una respuesta vacía válida es éxito con cero fixtures', () => {
    const result = normalizeFootballDataOrgMatches(successOutcome({ matches: [] }));

    expect(result).toEqual({ kind: 'success', fixtures: [], skipped: [] });
  });

  it('mapea el resto de los estados verificados', () => {
    const cases: Array<[string, string]> = [
      ['SCHEDULED', 'scheduled'],
      ['IN_PLAY', 'live'],
      ['PAUSED', 'live'],
      ['FINISHED', 'finished'],
      ['POSTPONED', 'postponed'],
      ['CANCELLED', 'cancelled'],
    ];

    for (const [providerStatus, expectedStatus] of cases) {
      const result = normalizeFootballDataOrgMatches(
        successOutcome({ matches: [{ ...VALID_MATCH, status: providerStatus }] }),
      );

      expect(result.kind).toBe('success');
      expect(result.kind === 'success' && result.fixtures[0]?.status).toBe(expectedStatus);
    }
  });

  it('toma el marcador de score.fullTime', () => {
    expect(firstScore(playedMatch(0, 2))).toEqual({ home: 0, away: 2 });
  });

  it('un 0–0 confirmado por el proveedor es un marcador, no la ausencia de uno', () => {
    expect(firstScore(playedMatch(0, 0))).toEqual({ home: 0, away: 0 });
  });

  it('un partido sin jugar no tiene marcador', () => {
    expect(firstScore(VALID_MATCH)).toBeNull();
  });

  it.each([
    ['falta score', { ...VALID_MATCH, score: undefined }],
    ['falta fullTime', { ...VALID_MATCH, score: { winner: null } }],
    ['falta un gol', playedMatch(1, null)],
    ['gol negativo', playedMatch(-1, 0)],
    ['gol decimal', playedMatch(1.5, 0)],
    ['gol como texto', playedMatch('1', 0)],
  ])('un marcador incompleto o inválido (%s) se importa sin marcador, nunca 0–0', (_, raw) => {
    expect(firstScore(raw)).toBeNull();
  });

  it('un estado desconocido se omite con motivo explícito, sin inventar un mapeo', () => {
    const result = normalizeFootballDataOrgMatches(
      successOutcome({ matches: [{ ...VALID_MATCH, status: 'SUSPENDED' }] }),
    );

    expect(result).toEqual({
      kind: 'success',
      fixtures: [],
      skipped: [{ reason: 'unrepresentable-status' }],
    });
  });

  it.each([
    ['id', 'invalid-match-id'],
    ['utcDate', 'invalid-kickoff-date'],
    ['competition', 'invalid-competition-id'],
    ['season', 'invalid-season-id'],
    ['homeTeam', 'invalid-home-team'],
    ['awayTeam', 'invalid-away-team'],
  ])('un %s faltante se omite como %s, sin persistir nada', (field, reason) => {
    const invalidMatch = { ...VALID_MATCH };
    delete (invalidMatch as Record<string, unknown>)[field];

    const result = normalizeFootballDataOrgMatches(successOutcome({ matches: [invalidMatch] }));

    expect(result).toEqual({ kind: 'success', fixtures: [], skipped: [{ reason }] });
  });

  it('matches con forma inesperada no interrumpe el resto de la página', () => {
    const result = normalizeFootballDataOrgMatches(
      successOutcome({ matches: [VALID_MATCH, null, { ...VALID_MATCH, id: 'no-numerico' }] }),
    );

    expect(result.kind).toBe('success');
    expect(result.kind === 'success' && result.fixtures).toHaveLength(1);
    expect(result.kind === 'success' && result.skipped).toEqual([
      { reason: 'invalid-match-id' },
      { reason: 'invalid-match-id' },
    ]);
  });

  it('un cuerpo sin "matches" como array produce un error tipado', () => {
    const result = normalizeFootballDataOrgMatches(successOutcome({ foo: 'bar' }));

    expect(result).toEqual({ kind: 'error', reason: 'invalid-response-shape' });
  });

  it('un HTTP no exitoso produce un error tipado', () => {
    const result = normalizeFootballDataOrgMatches({
      kind: 'response',
      status: 403,
      ok: false,
      body: { message: 'forbidden' },
      headers: {},
    });

    expect(result).toEqual({ kind: 'error', reason: 'http-error' });
  });

  it('un timeout produce un error tipado', () => {
    const result = normalizeFootballDataOrgMatches({ kind: 'timeout' });

    expect(result).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('un error de red produce un error tipado', () => {
    const result = normalizeFootballDataOrgMatches({
      kind: 'network-error',
      message: 'connection refused',
    });

    expect(result).toEqual({ kind: 'error', reason: 'network-error' });
  });

  it('un cuerpo inválido (JSON no parseable) produce un error tipado', () => {
    const result = normalizeFootballDataOrgMatches({
      kind: 'response',
      status: 200,
      ok: true,
      body: undefined,
      headers: {},
    });

    expect(result).toEqual({ kind: 'error', reason: 'invalid-json' });
  });
});
