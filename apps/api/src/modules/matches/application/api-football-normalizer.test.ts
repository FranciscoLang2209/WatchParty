import { describe, it, expect } from 'vitest';
import { normalizeApiFootballFixturesPage } from './api-football-normalizer.js';
import type { ApiFootballFetchOutcome } from '../infrastructure/api-football-client.js';

function successOutcome(body: unknown): ApiFootballFetchOutcome {
  return {
    kind: 'response',
    status: 200,
    ok: true,
    body,
    paging: (body as { paging?: unknown })?.paging,
  };
}

const VALID_FIXTURE = {
  fixture: { id: 971418, date: '2023-03-03T23:00:00+00:00', status: { short: 'FT' } },
  league: { id: 128, name: 'Liga Profesional Argentina', season: 2023 },
  teams: {
    home: { id: 441, name: 'Union Santa Fe' },
    away: { id: 450, name: 'Estudiantes L.P.' },
  },
};

describe('normalizeApiFootballFixturesPage', () => {
  it('normaliza un fixture válido con fecha ISO UTC y estado mapeado', () => {
    const result = normalizeApiFootballFixturesPage(
      successOutcome({
        errors: [],
        results: 1,
        paging: { current: 1, total: 1 },
        response: [VALID_FIXTURE],
      }),
    );

    expect(result).toEqual({
      kind: 'success',
      paging: { current: 1, total: 1 },
      fixtures: [
        {
          provider: 'api-football',
          externalFixtureId: 971418,
          externalLeagueId: 128,
          externalLeagueName: 'Liga Profesional Argentina',
          season: 2023,
          homeTeam: { externalTeamId: 441, name: 'Union Santa Fe' },
          awayTeam: { externalTeamId: 450, name: 'Estudiantes L.P.' },
          kickoffAt: '2023-03-03T23:00:00.000Z',
          status: 'finished',
        },
      ],
      skipped: [],
    });
  });

  it('una respuesta vacía válida es éxito con cero fixtures', () => {
    const result = normalizeApiFootballFixturesPage(
      successOutcome({ errors: [], results: 0, paging: { current: 1, total: 1 }, response: [] }),
    );

    expect(result).toEqual({
      kind: 'success',
      paging: { current: 1, total: 1 },
      fixtures: [],
      skipped: [],
    });
  });

  it('errors no vacío produce un error tipado', () => {
    const result = normalizeApiFootballFixturesPage(
      successOutcome({
        errors: ['Rate limit exceeded'],
        results: 0,
        paging: { current: 1, total: 1 },
        response: [],
      }),
    );

    expect(result).toEqual({ kind: 'error', reason: 'provider-errors' });
  });

  it('errors de tipo no admitido produce un error tipado', () => {
    const result = normalizeApiFootballFixturesPage(
      successOutcome({
        errors: 'oops',
        results: 0,
        paging: { current: 1, total: 1 },
        response: [],
      }),
    );

    expect(result).toEqual({ kind: 'error', reason: 'provider-errors' });
  });

  it('un HTTP no exitoso produce un error tipado', () => {
    const result = normalizeApiFootballFixturesPage({
      kind: 'response',
      status: 500,
      ok: false,
      body: undefined,
      paging: undefined,
    });

    expect(result).toEqual({ kind: 'error', reason: 'http-error' });
  });

  it('un timeout produce un error tipado', () => {
    const result = normalizeApiFootballFixturesPage({ kind: 'timeout' });

    expect(result).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('un cuerpo inválido (JSON no parseable) produce un error tipado', () => {
    const result = normalizeApiFootballFixturesPage({
      kind: 'response',
      status: 200,
      ok: true,
      body: undefined,
      paging: undefined,
    });

    expect(result).toEqual({ kind: 'error', reason: 'invalid-json' });
  });

  it('una paginación inválida produce un error tipado', () => {
    const result = normalizeApiFootballFixturesPage(
      successOutcome({
        errors: [],
        results: 0,
        paging: { current: 'uno', total: 1 },
        response: [],
      }),
    );

    expect(result).toEqual({ kind: 'error', reason: 'invalid-paging' });
  });

  it('una fecha inválida omite el fixture con motivo, sin usar la fecha actual', () => {
    const invalidDateFixture = {
      ...VALID_FIXTURE,
      fixture: { ...VALID_FIXTURE.fixture, date: 'no-es-una-fecha' },
    };

    const result = normalizeApiFootballFixturesPage(
      successOutcome({
        errors: [],
        results: 1,
        paging: { current: 1, total: 1 },
        response: [invalidDateFixture],
      }),
    );

    expect(result).toEqual({
      kind: 'success',
      paging: { current: 1, total: 1 },
      fixtures: [],
      skipped: [{ reason: 'invalid-kickoff-date' }],
    });
  });

  it('un estado no representable omite el fixture con motivo, sin normalizarlo a scheduled', () => {
    const suspendedFixture = {
      ...VALID_FIXTURE,
      fixture: { ...VALID_FIXTURE.fixture, status: { short: 'SUSP' } },
    };

    const result = normalizeApiFootballFixturesPage(
      successOutcome({
        errors: [],
        results: 1,
        paging: { current: 1, total: 1 },
        response: [suspendedFixture],
      }),
    );

    expect(result).toEqual({
      kind: 'success',
      paging: { current: 1, total: 1 },
      fixtures: [],
      skipped: [{ reason: 'unrepresentable-status' }],
    });
  });
});
