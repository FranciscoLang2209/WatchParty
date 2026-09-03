import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchesRouter } from './matches-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { Match } from '../domain/match.js';
import type { MatchCatalog } from '../domain/match-catalog.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: { id: 'user-123', email: 'persona@example.com' } },
    error: null,
  } as GetUserResult);
}

function buildCatalog(matches: readonly Match[]): MatchCatalog {
  return {
    list: async () => matches,
    findById: async (id) => matches.find((match) => match.id === id) ?? null,
  };
}

function buildTestApp(catalog: MatchCatalog) {
  const app = express();

  app.use('/matches', createMatchesRouter(catalog));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const MATCH_EARLY: Match = {
  id: 'aaa',
  homeTeam: 'Real Madrid',
  awayTeam: 'FC Barcelona',
  kickoffAt: '2026-09-06T21:00:00.000Z',
  status: 'scheduled',
};

const MATCH_EARLY_TIE: Match = {
  id: 'bbb',
  homeTeam: 'Manchester City',
  awayTeam: 'Liverpool',
  kickoffAt: '2026-09-06T21:00:00.000Z',
  status: 'scheduled',
};

const MATCH_LATE: Match = {
  id: 'zzz',
  homeTeam: 'River Plate',
  awayTeam: 'Boca Juniors',
  kickoffAt: '2026-09-13T19:00:00.000Z',
  status: 'scheduled',
};

describe('GET /matches', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido responde 200 con el catálogo serializado', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildCatalog([MATCH_EARLY]));

    const response = await request(app).get('/matches').set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matches: [MATCH_EARLY] });
  });

  it('con un catálogo vacío responde exactamente 200 { matches: [] }', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildCatalog([]));

    const response = await request(app).get('/matches').set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matches: [] });
  });

  it('ordena por kickoffAt ascendente y, ante empate, por id ascendente', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildCatalog([MATCH_LATE, MATCH_EARLY_TIE, MATCH_EARLY]));

    const response = await request(app).get('/matches').set('Authorization', 'Bearer good-token');

    expect(response.body.matches.map((match: { id: string }) => match.id)).toEqual([
      'aaa',
      'bbb',
      'zzz',
    ]);
  });

  it('sin token no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    const list = vi.fn();
    const catalog: MatchCatalog = { list, findById: vi.fn() };
    const app = buildTestApp(catalog);

    const response = await request(app).get('/matches');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('un fallo no controlado del catálogo responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const catalog: MatchCatalog = {
      list: async () => {
        throw new Error('detalle interno de base de datos');
      },
      findById: vi.fn(),
    };
    const app = buildTestApp(catalog);

    const response = await request(app).get('/matches').set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });

  it('ordena correctamente fechas con y sin milisegundos (no como texto)', async () => {
    const withoutMs: Match = { ...MATCH_EARLY, id: 'ms-1', kickoffAt: '2026-09-06T21:00:00Z' };
    const withMs: Match = { ...MATCH_EARLY, id: 'ms-2', kickoffAt: '2026-09-06T21:00:00.001Z' };

    mockAuthenticated();
    const app = buildTestApp(buildCatalog([withMs, withoutMs]));

    const response = await request(app).get('/matches').set('Authorization', 'Bearer good-token');

    expect(response.body.matches.map((match: { id: string }) => match.id)).toEqual([
      'ms-1',
      'ms-2',
    ]);
  });

  it('con un esquema distinto de Bearer no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    const list = vi.fn();
    const catalog: MatchCatalog = { list, findById: vi.fn() };
    const app = buildTestApp(catalog);

    const response = await request(app).get('/matches').set('Authorization', 'Basic abc123');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('con un Bearer vacío no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    const list = vi.fn();
    const catalog: MatchCatalog = { list, findById: vi.fn() };
    const app = buildTestApp(catalog);

    const response = await request(app).get('/matches').set('Authorization', 'Bearer ');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('con un token inválido no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);

    const list = vi.fn();
    const catalog: MatchCatalog = { list, findById: vi.fn() };
    const app = buildTestApp(catalog);

    const response = await request(app).get('/matches').set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(list).not.toHaveBeenCalled();
  });
});
