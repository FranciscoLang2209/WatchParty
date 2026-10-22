import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchRatingsRouter } from './match-ratings-router.js';
import { MatchRatingService } from '../application/match-rating-service.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { Match, MatchStatus } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import type { MatchRatingStore } from '../domain/match-rating-store.js';
import { MatchRatingPersistenceError } from '../infrastructure/match-rating-persistence-error.js';

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

/** GET y PUT se llaman igual; solo cambia el método HTTP. */
function send(app: Express, verb: 'get' | 'put', url: string) {
  return request(app)[verb](url);
}

const MATCH_ID = 'a1111111-1111-4111-8111-111111111111';
const URL = `/matches/${MATCH_ID}/rating`;

interface Setup {
  status?: MatchStatus;
  matchExists?: boolean;
  watched?: boolean;
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
  const watchedStore: WatchedMatchStore = {
    setWatched: vi.fn(),
    getWatched: vi.fn(async (_u, matchId) => ({ matchId, watched: options.watched ?? true })),
    listHistoryPage: vi.fn(),
  };
  const ratingStore: MatchRatingStore = {
    findRating: vi.fn(async () => null),
    saveRating: vi.fn(async (_u, _m, rating) => rating),
    getSummary: vi.fn(async () => ({ average: null, count: 0 })),
  };

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/matches',
    createMatchRatingsRouter(new MatchRatingService(catalog, watchedStore, ratingStore)),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, catalog, watchedStore, ratingStore };
}

beforeEach(() => {
  vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
});

describe('autenticación (GET y PUT)', () => {
  it.each(['get', 'put'] as const)('%s sin token responde 401 y no toca nada', async (verb) => {
    const { app, ratingStore, catalog } = buildTestApp();

    const pending = send(app, verb, URL);
    const response = await (verb === 'put' ? pending.send({ rating: 4 }) : pending);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
    expect(catalog.findById).not.toHaveBeenCalled();
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it.each(['get', 'put'] as const)('%s con token inválido responde 401', async (verb) => {
    mockInvalidToken();
    const { app, ratingStore } = buildTestApp();

    const pending = send(app, verb, URL).set('Authorization', 'Bearer bad');
    const response = await (verb === 'put' ? pending.send({ rating: 4 }) : pending);

    expect(response.status).toBe(401);
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it('la autenticación va antes que la validación: id inválido sin token es 401', async () => {
    const { app } = buildTestApp();

    expect((await request(app).put('/matches/no-es-uuid/rating').send({ rating: 4 })).status).toBe(
      401,
    );
  });
});

describe('GET /matches/:matchId/rating', () => {
  it('devuelve la nota propia con 200', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();
    vi.mocked(ratingStore.findRating).mockResolvedValueOnce(4);

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rating: 4 });
    expect(ratingStore.findRating).toHaveBeenCalledWith('user-123', MATCH_ID);
  });

  it('sin nota devuelve 200 { rating: null }', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rating: null });
  });

  it('ignora un userId en la query: la identidad es la del bearer', async () => {
    mockAuthenticated('user-123');
    const { app, ratingStore } = buildTestApp();

    await request(app).get(`${URL}?userId=otro-usuario`).set('Authorization', 'Bearer good');

    expect(ratingStore.findRating).toHaveBeenCalledWith('user-123', MATCH_ID);
  });

  it('id inválido responde 400 VALIDATION_ERROR', async () => {
    mockAuthenticated();
    const { app, catalog } = buildTestApp();

    const response = await request(app)
      .get('/matches/no-es-uuid/rating')
      .set('Authorization', 'Bearer good');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(catalog.findById).not.toHaveBeenCalled();
  });

  it('partido inexistente responde 404 NOT_FOUND', async () => {
    mockAuthenticated();
    const { app } = buildTestApp({ matchExists: false });

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('fallo de persistencia responde 500 genérico, sin detalles ni null', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();
    vi.mocked(ratingStore.findRating).mockRejectedValueOnce(
      new MatchRatingPersistenceError('No se pudo leer.', { message: 'postgres://u:pw@host' }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app).get(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
  });
});

describe('PUT /matches/:matchId/rating', () => {
  it.each([1, 2, 3, 4, 5])('guarda la nota %i y responde 200 { rating }', async (rating) => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();

    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rating });
    expect(ratingStore.saveRating).toHaveBeenCalledWith('user-123', MATCH_ID, rating);
  });

  it('repetir el mismo PUT responde igual cada vez (idempotente)', async () => {
    const { app, ratingStore } = buildTestApp();

    for (let i = 0; i < 2; i += 1) {
      mockAuthenticated();
      const response = await request(app)
        .put(URL)
        .set('Authorization', 'Bearer good')
        .send({ rating: 3 });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ rating: 3 });
    }
    expect(ratingStore.saveRating).toHaveBeenCalledTimes(2);
  });

  it('editar la nota con otro valor responde 200 con el nuevo valor', async () => {
    const { app } = buildTestApp();

    mockAuthenticated();
    await request(app).put(URL).set('Authorization', 'Bearer good').send({ rating: 2 });
    mockAuthenticated();
    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating: 5 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rating: 5 });
  });

  it('ignora un userId enviado en body y query: se guarda con la identidad del bearer', async () => {
    mockAuthenticated('user-123');
    const { app, ratingStore } = buildTestApp();

    const response = await request(app)
      .put(`${URL}?userId=otro-usuario`)
      .set('Authorization', 'Bearer good')
      .send({ rating: 4, userId: 'otro-usuario', user_id: 'otro-usuario' });

    expect(response.status).toBe(200);
    expect(ratingStore.saveRating).toHaveBeenCalledTimes(1);
    expect(ratingStore.saveRating).toHaveBeenCalledWith('user-123', MATCH_ID, 4);
  });

  it.each([
    ['decimal 3.5', { rating: 3.5 }],
    ['cero', { rating: 0 }],
    ['seis', { rating: 6 }],
    ['negativo', { rating: -1 }],
    ['string numérico', { rating: '4' }],
    ['null', { rating: null }],
    ['booleano', { rating: true }],
    ['array', { rating: [4] }],
    ['campo ausente', {}],
    ['campo con otro nombre', { nota: 4 }],
  ])('rechaza %s con 400 VALIDATION_ERROR sin consultar ni escribir', async (_label, body) => {
    mockAuthenticated();
    const { app, ratingStore, catalog } = buildTestApp();

    const response = await request(app).put(URL).set('Authorization', 'Bearer good').send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(catalog.findById).not.toHaveBeenCalled();
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it('sin body responde 400', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const response = await request(app).put(URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('body que no es JSON válido responde 400', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .set('Content-Type', 'application/json')
      .send('{"rating": ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('id de ruta inválido responde 400', async () => {
    mockAuthenticated();
    const { app, catalog } = buildTestApp();

    const response = await request(app)
      .put('/matches/no-es-uuid/rating')
      .set('Authorization', 'Bearer good')
      .send({ rating: 4 });

    expect(response.status).toBe(400);
    expect(catalog.findById).not.toHaveBeenCalled();
  });

  it('partido inexistente responde 404 NOT_FOUND y no escribe', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp({ matchExists: false });

    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating: 4 });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it.each<MatchStatus>(['scheduled', 'live', 'postponed', 'cancelled'])(
    'partido %s responde 409 CONFLICT y no escribe',
    async (status) => {
      mockAuthenticated();
      const { app, ratingStore } = buildTestApp({ status });

      const response = await request(app)
        .put(URL)
        .set('Authorization', 'Bearer good')
        .send({ rating: 4 });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(ratingStore.saveRating).not.toHaveBeenCalled();
    },
  );

  it('partido finalizado pero no visto responde 409 CONFLICT y no escribe', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp({ watched: false });

    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating: 4 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toMatch(/visto/);
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it('el "visto" se consulta con la identidad del bearer, no con la del body', async () => {
    mockAuthenticated('user-123');
    const { app, watchedStore } = buildTestApp();

    await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating: 4, userId: 'otro' });

    expect(watchedStore.getWatched).toHaveBeenCalledWith('user-123', MATCH_ID);
  });

  it('fallo de persistencia al guardar responde 500 genérico y sanitizado', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();
    vi.mocked(ratingStore.saveRating).mockRejectedValueOnce(
      new MatchRatingPersistenceError('No se pudo guardar.', { message: 'password=secreto' }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating: 4 });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('secreto');
  });

  it('fallo al consultar "visto" responde 500 y no escribe', async () => {
    mockAuthenticated();
    const { app, ratingStore, watchedStore } = buildTestApp();
    vi.mocked(watchedStore.getWatched).mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app)
      .put(URL)
      .set('Authorization', 'Bearer good')
      .send({ rating: 4 });

    expect(response.status).toBe(500);
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });
});

describe('GET /matches/:matchId/rating-summary', () => {
  const SUMMARY_URL = `/matches/${MATCH_ID}/rating-summary`;

  it('sin token responde 401 y no toca nada', async () => {
    const { app, ratingStore, catalog } = buildTestApp();

    const response = await request(app).get(SUMMARY_URL);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
    expect(catalog.findById).not.toHaveBeenCalled();
    expect(ratingStore.getSummary).not.toHaveBeenCalled();
  });

  it('con token inválido responde 401', async () => {
    mockInvalidToken();
    const { app, ratingStore } = buildTestApp();

    const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer bad');

    expect(response.status).toBe(401);
    expect(ratingStore.getSummary).not.toHaveBeenCalled();
  });

  it('id de partido inválido responde 400 sin tocar el servicio', async () => {
    mockAuthenticated();
    const { app, catalog, ratingStore } = buildTestApp();

    const response = await request(app)
      .get('/matches/no-es-uuid/rating-summary')
      .set('Authorization', 'Bearer good');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(catalog.findById).not.toHaveBeenCalled();
    expect(ratingStore.getSummary).not.toHaveBeenCalled();
  });

  it('partido inexistente responde 404 y no consulta el resumen', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp({ matchExists: false });

    const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(ratingStore.getSummary).not.toHaveBeenCalled();
  });

  it('devuelve promedio y cantidad de votos con 200', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();
    vi.mocked(ratingStore.getSummary).mockResolvedValueOnce({ average: 3.67, count: 3 });

    const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ average: 3.67, count: 3 });
    expect(ratingStore.getSummary).toHaveBeenCalledWith(MATCH_ID);
  });

  it('sin votos devuelve { average: null, count: 0 }, no un promedio cero', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ average: null, count: 0 });
    expect(response.body.average).toBeNull();
  });

  it('el resultado no depende de quién consulta ni de si vio el partido', async () => {
    const { app, ratingStore, watchedStore } = buildTestApp({ watched: false });
    vi.mocked(ratingStore.getSummary).mockResolvedValue({ average: 4, count: 2 });

    mockAuthenticated('user-A');
    const a = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer a');
    mockAuthenticated('user-B');
    const b = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer b');

    expect(a.body).toEqual({ average: 4, count: 2 });
    expect(b.body).toEqual(a.body);
    expect(watchedStore.getWatched).not.toHaveBeenCalled();
  });

  it.each<MatchStatus>(['scheduled', 'live', 'finished'])(
    'responde 200 con el partido en estado %s',
    async (status) => {
      mockAuthenticated();
      const { app } = buildTestApp({ status });

      const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer good');

      expect(response.status).toBe(200);
    },
  );

  it('expone solo { average, count }: ignora cualquier dato extra del servicio', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();
    vi.mocked(ratingStore.getSummary).mockResolvedValueOnce({
      average: 4,
      count: 2,
      userId: 'user-ajeno',
      ratings: [5, 3],
    } as never);

    const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer good');

    expect(Object.keys(response.body).sort()).toEqual(['average', 'count']);
    expect(JSON.stringify(response.body)).not.toContain('user-ajeno');
  });

  it('ignora un userId en la query: el resumen es del partido, no de un usuario', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();

    const response = await request(app)
      .get(`${SUMMARY_URL}?userId=otro-usuario`)
      .set('Authorization', 'Bearer good');

    expect(response.status).toBe(200);
    expect(ratingStore.getSummary).toHaveBeenCalledWith(MATCH_ID);
  });

  it('un fallo de persistencia responde 500 sanitizado, nunca "sin votos"', async () => {
    mockAuthenticated();
    const { app, ratingStore } = buildTestApp();
    vi.mocked(ratingStore.getSummary).mockRejectedValueOnce(
      new MatchRatingPersistenceError('No se pudo leer el resumen.', {
        message: 'password=secreto host=db.interno',
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app).get(SUMMARY_URL).set('Authorization', 'Bearer good');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('secreto');
  });
});
