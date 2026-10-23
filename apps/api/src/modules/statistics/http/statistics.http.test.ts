import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStatisticsRouter } from './statistics-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { UserStatistics, UserStatisticsStore } from '../domain/user-statistics-store.js';
import { UserStatisticsPersistenceError } from '../infrastructure/user-statistics-persistence-error.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(userId: string): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: { id: userId, email: `${userId}@example.com` } },
    error: null,
  } as GetUserResult);
}

function mockInvalidToken(): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: null },
    error: { message: 'invalid token' },
  } as GetUserResult);
}

const URL = '/me/statistics';

const STATS: Record<string, UserStatistics> = {
  'user-a': { watchedMatches: 3, ratings: 2, comments: 4 },
  'user-b': { watchedMatches: 1, ratings: 0, comments: 7 },
};

function buildTestApp(
  getUserStatistics: UserStatisticsStore['getUserStatistics'] = async (userId) =>
    STATS[userId] ?? { watchedMatches: 0, ratings: 0, comments: 0 },
) {
  const store = { getUserStatistics: vi.fn(getUserStatistics) };
  const app: Express = express();

  app.use(express.json());
  app.use('/me', createStatisticsRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, store };
}

describe('GET /me/statistics', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido devuelve los tres totales del usuario del bearer', async () => {
    mockAuthenticated('user-a');
    const { app, store } = buildTestApp();

    const response = await request(app).get(URL).set('Authorization', 'Bearer token-a');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      statistics: { watchedMatches: 3, ratings: 2, comments: 4 },
    });
    expect(store.getUserStatistics).toHaveBeenCalledExactlyOnceWith('user-a');
  });

  it('cada bearer ve solo sus propios totales', async () => {
    const { app } = buildTestApp();

    mockAuthenticated('user-a');
    const a = await request(app).get(URL).set('Authorization', 'Bearer token-a');
    mockAuthenticated('user-b');
    const b = await request(app).get(URL).set('Authorization', 'Bearer token-b');

    expect(a.body.statistics).toEqual(STATS['user-a']);
    expect(b.body.statistics).toEqual(STATS['user-b']);
  });

  it('ignora un userId en la query: no permite pedir los totales de otro usuario', async () => {
    mockAuthenticated('user-a');
    const { app, store } = buildTestApp();

    const response = await request(app)
      .get(`${URL}?userId=user-b&user_id=user-b`)
      .set('Authorization', 'Bearer token-a');

    expect(response.status).toBe(200);
    expect(response.body.statistics).toEqual(STATS['user-a']);
    expect(store.getUserStatistics).toHaveBeenCalledExactlyOnceWith('user-a');
  });

  it('no expone una ruta para consultar a otro usuario por id', async () => {
    mockAuthenticated('user-a');
    const { app, store } = buildTestApp();

    const response = await request(app).get(`${URL}/user-b`).set('Authorization', 'Bearer token-a');

    expect(response.status).toBe(404);
    expect(store.getUserStatistics).not.toHaveBeenCalled();
  });

  it('sin actividad responde ceros', async () => {
    mockAuthenticated('user-sin-actividad');
    const { app } = buildTestApp();

    const response = await request(app).get(URL).set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ statistics: { watchedMatches: 0, ratings: 0, comments: 0 } });
  });

  it('sin token responde 401 sin consultar el store', async () => {
    const { app, store } = buildTestApp();

    const response = await request(app).get(URL);

    expect(response.status).toBe(401);
    expect(store.getUserStatistics).not.toHaveBeenCalled();
    expect(supabaseAuthClient.auth.getUser).not.toHaveBeenCalled();
  });

  it('con token inválido responde 401 sin consultar el store', async () => {
    mockInvalidToken();
    const { app, store } = buildTestApp();

    const response = await request(app).get(URL).set('Authorization', 'Bearer vencido');

    expect(response.status).toBe(401);
    expect(store.getUserStatistics).not.toHaveBeenCalled();
  });

  it('un fallo de persistencia responde 500 genérico, nunca ceros ni el detalle interno', async () => {
    mockAuthenticated('user-a');
    const { app } = buildTestApp(async () => {
      throw new UserStatisticsPersistenceError('No se pudo contar los comentarios del usuario.', {
        message: 'timeout de Postgres en room_comments',
      });
    });

    const response = await request(app).get(URL).set('Authorization', 'Bearer token-a');

    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('statistics');
    expect(JSON.stringify(response.body)).not.toContain('Postgres');
  });
});
