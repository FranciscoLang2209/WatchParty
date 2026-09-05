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
  //creo un user mock
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: { id: 'user-123', email: 'persona@example.com' } },
    error: null,
  } as GetUserResult);
}

function buildCatalog(matches: readonly Match[]): MatchCatalog {
  //lleno el catalogo de partidos mock con los que tengo ahora
  return {
    list: async () => matches,
    findById: async (id) => matches.find((match) => match.id === id) ?? null,
  };
}

function buildTestApp(catalog: MatchCatalog) {
  //armo el server mock para testear
  const app = express();

  app.use('/matches', createMatchesRouter(catalog));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const MATCH: Match = {
  id: 'aaa',
  homeTeam: 'Real Madrid',
  awayTeam: 'FC Barcelona',
  kickoffAt: '2026-09-06T21:00:00.000Z',
  status: 'scheduled',
};

describe('GET /matches/:matchId', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido y un id existente responde 200 con exactamente los campos canónicos', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildCatalog([MATCH]));

    const response = await request(app)
      .get(`/matches/${MATCH.id}`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ match: MATCH });
    expect(Object.keys(response.body.match).sort()).toEqual(
      ['id', 'homeTeam', 'awayTeam', 'kickoffAt', 'status'].sort(),
    );
  });

  it('sin token no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    const findById = vi.fn();
    const catalog: MatchCatalog = { list: vi.fn(), findById };
    const app = buildTestApp(catalog);

    const response = await request(app).get(`/matches/${MATCH.id}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('con un esquema distinto de Bearer no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    const findById = vi.fn();
    const catalog: MatchCatalog = { list: vi.fn(), findById };
    const app = buildTestApp(catalog);

    const response = await request(app)
      .get(`/matches/${MATCH.id}`)
      .set('Authorization', 'Basic abc123');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('con un Bearer vacío no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    const findById = vi.fn();
    const catalog: MatchCatalog = { list: vi.fn(), findById };
    const app = buildTestApp(catalog);

    const response = await request(app).get(`/matches/${MATCH.id}`).set('Authorization', 'Bearer ');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('con un token inválido no invoca el catálogo y responde 401 UNAUTHORIZED', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);

    const findById = vi.fn();
    const catalog: MatchCatalog = { list: vi.fn(), findById };
    const app = buildTestApp(catalog);

    const response = await request(app)
      .get(`/matches/${MATCH.id}`)
      .set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('con un id inexistente y token válido responde 404 NOT_FOUND', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildCatalog([MATCH]));

    const response = await request(app)
      .get('/matches/no-existe')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('un fallo no controlado del catálogo responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const catalog: MatchCatalog = {
      list: vi.fn(),
      findById: async () => {
        throw new Error('detalle interno de base de datos');
      },
    };
    const app = buildTestApp(catalog);

    const response = await request(app)
      .get(`/matches/${MATCH.id}`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });
});
