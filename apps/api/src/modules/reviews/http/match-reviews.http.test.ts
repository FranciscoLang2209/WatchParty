import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchReviewsRouter } from './match-reviews-router.js';
import { MatchReviewService } from '../application/match-review-service.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { Match, MatchStatus } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { MatchReview, MatchReviewStore } from '../domain/match-review-store.js';
import { MatchReviewPersistenceError } from '../infrastructure/match-review-persistence-error.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: { auth: { getUser: vi.fn() } },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(userId = 'user-123'): void {
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

const MATCH_ID = 'a1111111-1111-4111-8111-111111111111';
const URL = `/matches/${MATCH_ID}/review`;

const REVIEW: MatchReview = {
  body: 'Gran partido',
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-31T09:30:00.000Z',
};

interface Setup {
  status?: MatchStatus;
  matchExists?: boolean;
  /** Reseñas guardadas por usuario: el doble solo devuelve la del que pregunta. */
  reviewsByUser?: Record<string, MatchReview>;
}

function buildTestApp(options: Setup = {}) {
  const match: Match | null =
    options.matchExists === false
      ? null
      : {
          id: MATCH_ID,
          homeTeam: 'A',
          homeTeamId: 'h',
          awayTeam: 'B',
          awayTeamId: 'a',
          kickoffAt: '2026-10-01T20:00:00Z',
          status: options.status ?? 'finished',
          score: null,
        };
  const catalog: MatchCatalog = { list: vi.fn(), findById: vi.fn(async () => match) };
  const reviewStore: MatchReviewStore = {
    findReview: vi.fn(async (userId) => options.reviewsByUser?.[userId] ?? null),
  };

  const app: Express = express();
  app.use(express.json());
  app.use('/matches', createMatchReviewsRouter(new MatchReviewService(catalog, reviewStore)));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, catalog, reviewStore };
}

beforeEach(() => {
  vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
});

describe('autenticación', () => {
  it('sin token responde 401 y no toca nada', async () => {
    const { app, catalog, reviewStore } = buildTestApp();

    const response = await request(app).get(URL);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
    expect(catalog.findById).not.toHaveBeenCalled();
    expect(reviewStore.findReview).not.toHaveBeenCalled();
  });

  it('con token inválido responde 401', async () => {
    mockInvalidToken();
    const { app, reviewStore } = buildTestApp();

    const response = await request(app).get(URL).set('Authorization', 'Bearer bad');

    expect(response.status).toBe(401);
    expect(reviewStore.findReview).not.toHaveBeenCalled();
  });

  it('la autenticación va antes que la validación: id inválido sin token es 401', async () => {
    const { app } = buildTestApp();

    expect((await request(app).get('/matches/no-es-uuid/review')).status).toBe(401);
  });
});

describe('GET /matches/:matchId/review', () => {
  it('devuelve la reseña propia con 200', async () => {
    mockAuthenticated();
    const { app, reviewStore } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ review: REVIEW });
    expect(reviewStore.findReview).toHaveBeenCalledWith('user-123', MATCH_ID);
  });

  it('sin reseña devuelve 200 { review: null }', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ review: null });
  });

  it('otra cuenta con reseña no filtra su texto: quien no reseñó recibe null', async () => {
    mockAuthenticated('user-sin-resena');
    const { app, reviewStore } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ review: null });
    expect(JSON.stringify(response.body)).not.toContain(REVIEW.body);
    expect(reviewStore.findReview).toHaveBeenCalledWith('user-sin-resena', MATCH_ID);
  });

  it('ignora un userId en la query: la identidad es la del bearer', async () => {
    mockAuthenticated('user-sin-resena');
    const { app, reviewStore } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

    const response = await request(app)
      .get(`${URL}?userId=user-123`)
      .set('Authorization', 'Bearer good');

    expect(response.body).toEqual({ review: null });
    expect(reviewStore.findReview).toHaveBeenCalledTimes(1);
    expect(reviewStore.findReview).toHaveBeenCalledWith('user-sin-resena', MATCH_ID);
  });

  it('expone solo { body, createdAt, updatedAt }: ignora cualquier dato extra del store', async () => {
    mockAuthenticated();
    const { app, reviewStore } = buildTestApp();
    vi.mocked(reviewStore.findReview).mockResolvedValueOnce({
      ...REVIEW,
      userId: 'user-123',
      matchId: MATCH_ID,
    } as MatchReview);

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.body).toEqual({ review: REVIEW });
  });

  it.each(['scheduled', 'live', 'finished'] as const)(
    'no cambia la elegibilidad: una reseña ya guardada se lee con el partido en estado %s',
    async (status) => {
      mockAuthenticated();
      const { app } = buildTestApp({ status, reviewsByUser: { 'user-123': REVIEW } });

      const response = await request(app).get(URL).set('Authorization', 'Bearer good');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ review: REVIEW });
    },
  );

  it('id inválido responde 400 VALIDATION_ERROR', async () => {
    mockAuthenticated();
    const { app, catalog } = buildTestApp();

    const response = await request(app)
      .get('/matches/no-es-uuid/review')
      .set('Authorization', 'Bearer good');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(catalog.findById).not.toHaveBeenCalled();
  });

  it('partido inexistente responde 404 NOT_FOUND y no consulta la reseña', async () => {
    mockAuthenticated();
    const { app, reviewStore } = buildTestApp({ matchExists: false });

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(reviewStore.findReview).not.toHaveBeenCalled();
  });

  it('fallo de persistencia responde 500 genérico, sin detalles ni null', async () => {
    mockAuthenticated();
    const { app, reviewStore } = buildTestApp();
    vi.mocked(reviewStore.findReview).mockRejectedValueOnce(
      new MatchReviewPersistenceError('No se pudo leer.', { message: 'postgres://u:pw@host' }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
  });

  it('no existe otra forma de leer: POST/PUT/DELETE sobre /review no están implementados', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const response = await request(app).put(URL).set('Authorization', 'Bearer good').send({});

    expect(response.status).toBe(404);
  });
});
