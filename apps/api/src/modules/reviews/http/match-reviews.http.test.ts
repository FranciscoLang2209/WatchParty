import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchReviewsRouter } from './match-reviews-router.js';
import { MatchReviewService } from '../application/match-review-service.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { Match, MatchStatus } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import type { MatchRatingStore } from '../../ratings/domain/match-rating-store.js';
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
  /** El usuario marcó el partido como visto (por defecto sí). */
  watched?: boolean;
  /** Nota propia ya guardada (por defecto 4); `null` = todavía sin calificar. */
  rating?: number | null;
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
    findRating: vi.fn(async () => (options.rating === undefined ? 4 : options.rating)),
    saveRating: vi.fn(),
    getSummary: vi.fn(),
  };
  // Doble con estado: una fila por (usuario, partido), como la PK de la base.
  const saved = new Map(Object.entries(options.reviewsByUser ?? {}));
  const reviewStore: MatchReviewStore = {
    findReview: vi.fn(async (userId) => saved.get(userId) ?? null),
    saveReview: vi.fn(async (userId, _matchId, body) => {
      const previous = saved.get(userId);
      const review: MatchReview = {
        body,
        createdAt: previous?.createdAt ?? '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-02T10:00:00.000Z',
      };
      saved.set(userId, review);
      return review;
    }),
  };

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/matches',
    createMatchReviewsRouter(
      new MatchReviewService(catalog, watchedStore, ratingStore, reviewStore),
    ),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, catalog, reviewStore, ratingStore, watchedStore, saved };
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
});

describe('PUT /matches/:matchId/review', () => {
  const put = (app: Express, body: unknown = { body: 'Gran partido' }, url = URL) =>
    request(app)
      .put(url)
      .set('Authorization', 'Bearer good')
      .send(body as object);

  describe('autenticación', () => {
    it('sin token responde 401 y no toca nada', async () => {
      const { app, catalog, reviewStore } = buildTestApp();

      const response = await request(app).put(URL).send({ body: 'Gran partido' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
      expect(catalog.findById).not.toHaveBeenCalled();
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });

    it('con token inválido responde 401 y no guarda', async () => {
      mockInvalidToken();
      const { app, reviewStore } = buildTestApp();

      const response = await request(app)
        .put(URL)
        .set('Authorization', 'Bearer bad')
        .send({ body: 'Gran partido' });

      expect(response.status).toBe(401);
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });

    it('la autenticación va antes que la validación: id y texto inválidos sin token son 401', async () => {
      const { app } = buildTestApp();

      expect((await request(app).put('/matches/no-es-uuid/review').send({})).status).toBe(401);
    });
  });

  describe('alta y edición', () => {
    it('crea la reseña con 200 y la devuelve con el mismo formato que el GET', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();

      const response = await put(app);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        review: {
          body: 'Gran partido',
          createdAt: '2026-11-01T10:00:00.000Z',
          updatedAt: '2026-11-02T10:00:00.000Z',
        },
      });
      expect(reviewStore.saveReview).toHaveBeenCalledWith('user-123', MATCH_ID, 'Gran partido');
    });

    it('edita la reseña existente: reemplaza el texto, no duplica y conserva createdAt', async () => {
      mockAuthenticated();
      const { app, saved } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      const response = await put(app, { body: 'Mejor de lo que recordaba' });

      expect(response.status).toBe(200);
      expect(response.body.review.body).toBe('Mejor de lo que recordaba');
      expect(response.body.review.createdAt).toBe(REVIEW.createdAt);
      expect(saved.size).toBe(1);
      expect(saved.get('user-123')?.body).toBe('Mejor de lo que recordaba');
    });

    it('un GET posterior devuelve lo guardado', async () => {
      mockAuthenticated();
      const { app } = buildTestApp();
      await put(app, { body: 'Se me hizo corto' });

      mockAuthenticated();
      const response = await request(app).get(URL).set('Authorization', 'Bearer good');

      expect(response.body.review.body).toBe('Se me hizo corto');
    });

    it('guarda el texto sin los espacios exteriores y respeta los interiores', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();

      const response = await put(app, { body: '  \n Gran   partido \t ' });

      expect(response.status).toBe(200);
      expect(response.body.review.body).toBe('Gran   partido');
      expect(reviewStore.saveReview).toHaveBeenCalledWith('user-123', MATCH_ID, 'Gran   partido');
    });

    it('trata el texto como texto plano: HTML y saltos de línea se guardan tal cual', async () => {
      mockAuthenticated();
      const { app } = buildTestApp();

      const response = await put(app, { body: '<b>Golazo</b>\n<script>x()</script>' });

      expect(response.status).toBe(200);
      expect(response.body.review.body).toBe('<b>Golazo</b>\n<script>x()</script>');
    });

    it('acepta exactamente 500 caracteres y 1 carácter', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app } = buildTestApp();

      expect((await put(app, { body: 'a'.repeat(500) })).status).toBe(200);
      expect((await put(app, { body: 'a' })).status).toBe(200);
    });

    it('cuenta caracteres, no unidades UTF-16: 500 emojis entran y 501 no', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app } = buildTestApp();

      expect((await put(app, { body: '⚽'.repeat(250) + '🏆'.repeat(250) })).status).toBe(200);
      expect((await put(app, { body: '🏆'.repeat(501) })).status).toBe(400);
    });
  });

  describe('reintento', () => {
    it('repetir el mismo PUT deja una sola reseña y no la reescribe', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app, reviewStore, saved } = buildTestApp();

      const first = await put(app, { body: 'Gran partido' });
      const second = await put(app, { body: 'Gran partido' });

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(saved.size).toBe(1);
      expect(reviewStore.saveReview).toHaveBeenCalledTimes(1);
    });

    it('repetir con otros espacios exteriores cuenta como el mismo texto', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();

      await put(app, { body: 'Gran partido' });
      const second = await put(app, { body: '  Gran partido  ' });

      expect(second.status).toBe(200);
      expect(reviewStore.saveReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('autor', () => {
    it('ignora un userId en el body y en la query: la identidad es la del bearer', async () => {
      mockAuthenticated('user-123');
      const { app, reviewStore, saved } = buildTestApp();

      const response = await put(
        app,
        { body: 'Gran partido', userId: 'otro-usuario', user_id: 'otro-usuario' },
        `${URL}?userId=otro-usuario`,
      );

      expect(response.status).toBe(200);
      expect(reviewStore.saveReview).toHaveBeenCalledWith('user-123', MATCH_ID, 'Gran partido');
      expect([...saved.keys()]).toEqual(['user-123']);
    });

    it('no toca la reseña de otro usuario', async () => {
      mockAuthenticated('user-nuevo');
      const { app, saved } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      await put(app, { body: 'Mi opinión' });

      expect(saved.get('user-123')).toEqual(REVIEW);
      expect(saved.get('user-nuevo')?.body).toBe('Mi opinión');
    });
  });

  describe('texto inválido', () => {
    it.each([
      ['solicitud sin cuerpo', ''],
      ['body {}', {}],
      ['body null', { body: null }],
      ['body numérico', { body: 5 }],
      ['body booleano', { body: true }],
      ['body arreglo', { body: ['Gran partido'] }],
      ['body objeto', { body: { text: 'Gran partido' } }],
      ['texto vacío', { body: '' }],
      ['solo espacios', { body: '    ' }],
      ['solo saltos y tabulaciones', { body: ' \n\t\r ' }],
      ['501 caracteres', { body: 'a'.repeat(501) }],
      ['501 caracteres tras recortar', { body: ` ${'a'.repeat(501)} ` }],
      ['carácter nulo', { body: 'hola\u0000chau' }],
      ['carácter de control', { body: 'hola\u0007chau' }],
    ])('%s responde 400 VALIDATION_ERROR y no guarda', async (_label, payload) => {
      mockAuthenticated();
      const { app, catalog, reviewStore } = buildTestApp();

      const response = await put(app, payload);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
      expect(catalog.findById).not.toHaveBeenCalled();
    });

    it('un JSON malformado responde 400 VALIDATION_ERROR', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();

      const response = await request(app)
        .put(URL)
        .set('Authorization', 'Bearer good')
        .set('Content-Type', 'application/json')
        .send('{"body": ');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });

    it('un texto inválido no pisa la reseña ya guardada', async () => {
      mockAuthenticated();
      const { app, saved } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      await put(app, { body: '   ' });

      expect(saved.get('user-123')).toEqual(REVIEW);
    });

    it('id de partido inválido responde 400 VALIDATION_ERROR', async () => {
      mockAuthenticated();
      const { app, catalog } = buildTestApp();

      const response = await put(app, { body: 'Gran partido' }, '/matches/no-es-uuid/review');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(catalog.findById).not.toHaveBeenCalled();
    });
  });

  describe('partido no elegible', () => {
    it('partido inexistente responde 404 NOT_FOUND y no guarda', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({ matchExists: false });

      const response = await put(app);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });

    it.each(['scheduled', 'live'] as const)(
      'partido %s responde 409 CONFLICT y no guarda',
      async (status) => {
        mockAuthenticated();
        const { app, reviewStore } = buildTestApp({ status });

        const response = await put(app);

        expect(response.status).toBe(409);
        expect(response.body.error).toEqual({
          code: 'CONFLICT',
          message: 'Sólo se puede reseñar un partido finalizado.',
        });
        expect(reviewStore.saveReview).not.toHaveBeenCalled();
      },
    );

    it('partido no marcado como visto responde 409 CONFLICT y no guarda', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({ watched: false });

      const response = await put(app);

      expect(response.status).toBe(409);
      expect(response.body.error).toEqual({
        code: 'CONFLICT',
        message: 'Marcá el partido como visto para poder reseñarlo.',
      });
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });

    it('partido sin nota propia responde 409 CONFLICT y no guarda', async () => {
      mockAuthenticated();
      const { app, reviewStore, ratingStore } = buildTestApp({ rating: null });

      const response = await put(app);

      expect(response.status).toBe(409);
      expect(response.body.error).toEqual({
        code: 'CONFLICT',
        message: 'Calificá el partido para poder reseñarlo.',
      });
      expect(ratingStore.findRating).toHaveBeenCalledWith('user-123', MATCH_ID);
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });

    it('la elegibilidad se evalúa con el usuario del bearer', async () => {
      mockAuthenticated('user-456');
      const { app, watchedStore } = buildTestApp();

      await put(app);

      expect(watchedStore.getWatched).toHaveBeenCalledWith('user-456', MATCH_ID);
    });
  });

  describe('nota y agregados intactos', () => {
    it('reseñar nunca escribe ni recalcula notas', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app, ratingStore } = buildTestApp({ rating: 4 });

      await put(app, { body: 'Gran partido' });
      await put(app, { body: 'Gran partido, editado' });

      // Solo se lee la nota propia para comprobar elegibilidad.
      expect(ratingStore.saveRating).not.toHaveBeenCalled();
      expect(ratingStore.getSummary).not.toHaveBeenCalled();
      expect(ratingStore.findRating).toHaveBeenCalledTimes(2);
    });
  });

  describe('fallos de persistencia', () => {
    it('un fallo al guardar responde 500 genérico, sin detalles', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();
      vi.mocked(reviewStore.saveReview).mockRejectedValueOnce(
        new MatchReviewPersistenceError('No se pudo guardar.', { message: 'postgres://u:pw@host' }),
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const response = await put(app);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
      });
      expect(JSON.stringify(response.body)).not.toContain('postgres://');
    });

    it('un fallo al leer la nota propia responde 500 y no guarda ni se trata como "sin nota"', async () => {
      mockAuthenticated();
      const { app, reviewStore, ratingStore } = buildTestApp();
      vi.mocked(ratingStore.findRating).mockRejectedValueOnce(new Error('boom'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const response = await put(app);

      expect(response.status).toBe(500);
      expect(reviewStore.saveReview).not.toHaveBeenCalled();
    });
  });

  it('no existen otros métodos sobre /review: POST y DELETE responden 404', async () => {
    mockAuthenticated();
    mockAuthenticated();
    const { app } = buildTestApp();

    const post = await request(app).post(URL).set('Authorization', 'Bearer good').send({});
    const del = await request(app).delete(URL).set('Authorization', 'Bearer good');

    expect(post.status).toBe(404);
    expect(del.status).toBe(404);
  });
});
