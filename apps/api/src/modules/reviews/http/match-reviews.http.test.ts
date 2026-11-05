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
import {
  ANONYMOUS_REVIEW_AUTHOR_NAME,
  type MatchReview,
  type MatchReviewStore,
} from '../domain/match-review-store.js';
import { createReviewsCursorCodec } from '../domain/match-review-cursor.js';
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
  /** Nombre visible por usuario (tabla `profiles`); sin entrada = sin perfil. */
  profileNames?: Record<string, string>;
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
    deleteReview: vi.fn(async (userId) => {
      saved.delete(userId);
    }),
    // Doble con el mismo orden que la base: created_at desc y user_id desc.
    listMatchReviews: vi.fn(async (_matchId, { limit, after }) => {
      const entries = [...saved.entries()]
        .map(([userId, review]) => ({ userId, review }))
        .sort(
          (a, b) =>
            b.review.createdAt.localeCompare(a.review.createdAt) ||
            b.userId.localeCompare(a.userId),
        );
      const rest = after
        ? entries.filter(
            (e) =>
              e.review.createdAt < after.createdAt ||
              (e.review.createdAt === after.createdAt && e.userId < after.userId),
          )
        : entries;
      const page = rest.slice(0, limit);
      const last = page[page.length - 1];

      return {
        items: page.map((e) => ({
          authorName: options.profileNames?.[e.userId] ?? ANONYMOUS_REVIEW_AUTHOR_NAME,
          body: e.review.body,
          createdAt: e.review.createdAt,
        })),
        nextCursor:
          rest.length > limit && last
            ? { createdAt: last.review.createdAt, userId: last.userId }
            : null,
      };
    }),
  };

  const cursorCodec = createReviewsCursorCodec('secreto-de-prueba-con-32-caracteres!!');

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/matches',
    createMatchReviewsRouter(
      new MatchReviewService(catalog, watchedStore, ratingStore, reviewStore),
      cursorCodec,
    ),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, catalog, reviewStore, ratingStore, watchedStore, saved, cursorCodec };
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
});

describe('DELETE /matches/:matchId/review', () => {
  const del = (app: Express, token = 'Bearer good', url = URL) =>
    request(app).delete(url).set('Authorization', token);

  describe('autenticación', () => {
    it('sin token responde 401 y no borra nada', async () => {
      const { app, catalog, reviewStore, saved } = buildTestApp({
        reviewsByUser: { 'user-123': REVIEW },
      });

      const response = await request(app).delete(URL);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
      expect(catalog.findById).not.toHaveBeenCalled();
      expect(reviewStore.deleteReview).not.toHaveBeenCalled();
      expect(saved.get('user-123')).toEqual(REVIEW);
    });

    it('con token inválido responde 401 y no borra', async () => {
      mockInvalidToken();
      const { app, reviewStore } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      const response = await del(app, 'Bearer bad');

      expect(response.status).toBe(401);
      expect(reviewStore.deleteReview).not.toHaveBeenCalled();
    });

    it('la autenticación va antes que la validación: id inválido sin token es 401', async () => {
      const { app } = buildTestApp();

      expect((await request(app).delete('/matches/no-es-uuid/review')).status).toBe(401);
    });
  });

  describe('eliminar el texto', () => {
    it('borra la reseña propia con 200 { review: null } y un GET posterior devuelve null', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app, reviewStore, saved } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      const response = await del(app);
      const after = await request(app).get(URL).set('Authorization', 'Bearer good');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ review: null });
      expect(reviewStore.deleteReview).toHaveBeenCalledWith('user-123', MATCH_ID);
      expect(saved.has('user-123')).toBe(false);
      expect(after.body).toEqual({ review: null });
    });

    it('repetir el borrado deja el mismo estado y la misma respuesta, sin error', async () => {
      mockAuthenticated();
      mockAuthenticated();
      mockAuthenticated();
      const { app, saved } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      const first = await del(app);
      const second = await del(app);
      const third = await del(app);

      for (const response of [first, second, third]) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ review: null });
      }
      expect(saved.size).toBe(0);
    });

    it('sin reseña previa también responde 200 { review: null }', async () => {
      mockAuthenticated();
      const { app } = buildTestApp();

      const response = await del(app);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ review: null });
    });

    it('se puede borrar aunque el usuario haya deshecho "visto"', async () => {
      mockAuthenticated();
      const { app, saved, watchedStore } = buildTestApp({
        watched: false,
        reviewsByUser: { 'user-123': REVIEW },
      });

      const response = await del(app);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ review: null });
      expect(saved.has('user-123')).toBe(false);
      expect(watchedStore.getWatched).not.toHaveBeenCalled();
    });

    it('se puede borrar aunque el partido no esté finalizado o el usuario no tenga nota', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const live = buildTestApp({ status: 'live', reviewsByUser: { 'user-123': REVIEW } });
      const unrated = buildTestApp({ rating: null, reviewsByUser: { 'user-123': REVIEW } });

      expect((await del(live.app)).status).toBe(200);
      expect((await del(unrated.app)).status).toBe(200);
      expect(live.saved.size).toBe(0);
      expect(unrated.saved.size).toBe(0);
    });
  });

  describe('autor', () => {
    it('no puede borrar la reseña de otra cuenta: cada quien solo borra la suya', async () => {
      mockAuthenticated('user-b');
      const { app, reviewStore, saved } = buildTestApp({
        reviewsByUser: { 'user-123': REVIEW, 'user-b': { ...REVIEW, body: 'Otra opinión' } },
      });

      const response = await del(app);

      expect(response.status).toBe(200);
      expect(reviewStore.deleteReview).toHaveBeenCalledWith('user-b', MATCH_ID);
      expect(saved.get('user-123')).toEqual(REVIEW);
      expect(saved.has('user-b')).toBe(false);
    });

    it('un usuario sin reseña no afecta la de otro', async () => {
      mockAuthenticated('user-sin-resena');
      const { app, saved } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });

      expect((await del(app)).status).toBe(200);
      expect(saved.get('user-123')).toEqual(REVIEW);
    });

    it('ignora un userId en el body y en la query: la identidad es la del bearer', async () => {
      mockAuthenticated('user-b');
      const { app, reviewStore, saved } = buildTestApp({
        reviewsByUser: { 'user-123': REVIEW },
      });

      const response = await request(app)
        .delete(`${URL}?userId=user-123`)
        .set('Authorization', 'Bearer good')
        .send({ userId: 'user-123' });

      expect(response.status).toBe(200);
      expect(reviewStore.deleteReview).toHaveBeenCalledTimes(1);
      expect(reviewStore.deleteReview).toHaveBeenCalledWith('user-b', MATCH_ID);
      expect(saved.get('user-123')).toEqual(REVIEW);
    });
  });

  describe('nota, visto y agregados intactos', () => {
    it('borrar el texto nunca escribe notas ni vistos, y la nota propia se conserva', async () => {
      mockAuthenticated();
      const { app, ratingStore, watchedStore } = buildTestApp({
        rating: 4,
        reviewsByUser: { 'user-123': REVIEW },
      });

      const response = await del(app);

      expect(response.status).toBe(200);
      expect(ratingStore.saveRating).not.toHaveBeenCalled();
      expect(ratingStore.getSummary).not.toHaveBeenCalled();
      expect(watchedStore.setWatched).not.toHaveBeenCalled();
      expect(await ratingStore.findRating('user-123', MATCH_ID)).toBe(4);
    });
  });

  describe('validación y errores', () => {
    it('id inválido responde 400 VALIDATION_ERROR y no borra', async () => {
      mockAuthenticated();
      const { app, catalog, reviewStore } = buildTestApp({
        reviewsByUser: { 'user-123': REVIEW },
      });

      const response = await del(app, 'Bearer good', '/matches/no-es-uuid/review');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(catalog.findById).not.toHaveBeenCalled();
      expect(reviewStore.deleteReview).not.toHaveBeenCalled();
    });

    it('partido inexistente responde 404 NOT_FOUND y no borra', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({
        matchExists: false,
        reviewsByUser: { 'user-123': REVIEW },
      });

      const response = await del(app);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(reviewStore.deleteReview).not.toHaveBeenCalled();
    });

    it('un fallo de persistencia responde 500 genérico, sin detalles ni éxito', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({ reviewsByUser: { 'user-123': REVIEW } });
      vi.mocked(reviewStore.deleteReview).mockRejectedValueOnce(
        new MatchReviewPersistenceError('No se pudo eliminar la reseña.', {
          message: 'password=secreto host=db.interno',
        }),
      );

      const response = await del(app);

      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('review');
      expect(JSON.stringify(response.body)).not.toContain('secreto');
      expect(JSON.stringify(response.body)).not.toContain('db.interno');
    });
  });
});

describe('otros métodos sobre /review', () => {
  it('POST sigue sin existir y responde 404', async () => {
    mockAuthenticated();
    const { app } = buildTestApp();

    const post = await request(app).post(URL).set('Authorization', 'Bearer good').send({});

    expect(post.status).toBe(404);
  });
});

describe('GET /matches/:matchId/reviews', () => {
  const LIST_URL = `/matches/${MATCH_ID}/reviews`;
  const U1 = 'c1111111-1111-4111-8111-111111111111';
  const U2 = 'c2222222-2222-4222-8222-222222222222';
  const U3 = 'c3333333-3333-4333-8333-333333333333';
  const U4 = 'c4444444-4444-4444-8444-444444444444';
  const U5 = 'c5555555-5555-4555-8555-555555555555';

  const at = (day: number, body: string): MatchReview => ({
    body,
    createdAt: `2026-11-0${day}T10:00:00.000Z`,
    updatedAt: `2026-11-0${day}T10:00:00.000Z`,
  });

  const list = (app: Express, query = '', url = LIST_URL) =>
    request(app).get(`${url}${query}`).set('Authorization', 'Bearer good');

  /** Recorre todas las páginas con `limit` y devuelve los textos en orden. */
  async function walk(app: Express, limit: number): Promise<string[]> {
    const bodies: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 20; guard++) {
      mockAuthenticated();
      const suffix: string = cursor ? `&cursor=${cursor}` : '';
      const response = await list(app, `?limit=${limit}${suffix}`);
      expect(response.status).toBe(200);
      bodies.push(...response.body.reviews.map((r: { body: string }) => r.body));
      cursor = response.body.nextCursor;
      if (cursor === null) return bodies;
    }
    throw new Error('La paginación no terminó');
  }

  describe('autenticación', () => {
    it('sin token responde 401 y no consulta nada', async () => {
      const { app, catalog, reviewStore } = buildTestApp();

      const response = await request(app).get(LIST_URL);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
      expect(catalog.findById).not.toHaveBeenCalled();
      expect(reviewStore.listMatchReviews).not.toHaveBeenCalled();
    });

    it('con token inválido responde 401', async () => {
      mockInvalidToken();
      const { app, reviewStore } = buildTestApp();

      expect((await list(app)).status).toBe(401);
      expect(reviewStore.listMatchReviews).not.toHaveBeenCalled();
    });

    it('la autenticación va antes que la validación: id y cursor inválidos sin token son 401', async () => {
      const { app } = buildTestApp();

      expect((await request(app).get('/matches/no-es-uuid/reviews?cursor=%%')).status).toBe(401);
    });
  });

  describe('contenido', () => {
    it('partido sin reseñas responde 200 con lista vacía y sin cursor', async () => {
      mockAuthenticated();
      const { app } = buildTestApp();

      const response = await list(app);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ reviews: [], nextCursor: null });
    });

    it('lista de la más reciente a la más antigua, con nombre, texto y fecha', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({
        reviewsByUser: { [U1]: at(1, 'Primera'), [U2]: at(3, 'Tercera'), [U3]: at(2, 'Segunda') },
        profileNames: { [U1]: 'Ana', [U2]: 'Beto', [U3]: 'Cami' },
      });

      const response = await list(app);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        reviews: [
          { authorName: 'Beto', body: 'Tercera', createdAt: '2026-11-03T10:00:00.000Z' },
          { authorName: 'Cami', body: 'Segunda', createdAt: '2026-11-02T10:00:00.000Z' },
          { authorName: 'Ana', body: 'Primera', createdAt: '2026-11-01T10:00:00.000Z' },
        ],
        nextCursor: null,
      });
      expect(reviewStore.listMatchReviews).toHaveBeenCalledWith(MATCH_ID, { limit: 20 });
    });

    it('incluye la reseña del propio usuario como una más', async () => {
      mockAuthenticated(U1);
      const { app } = buildTestApp({
        reviewsByUser: { [U1]: at(1, 'Mía'), [U2]: at(2, 'Ajena') },
        profileNames: { [U1]: 'Ana', [U2]: 'Beto' },
      });

      const response = await list(app);

      expect(response.body.reviews.map((r: { body: string }) => r.body)).toEqual(['Ajena', 'Mía']);
    });

    it('autor sin perfil: usa la etiqueta neutra, nunca algo derivado del email', async () => {
      mockAuthenticated('lector');
      const { app } = buildTestApp({
        reviewsByUser: { 'maria-lopez': at(1, 'Sin perfil') },
      });

      const response = await list(app);

      expect(response.body.reviews).toEqual([
        {
          authorName: ANONYMOUS_REVIEW_AUTHOR_NAME,
          body: 'Sin perfil',
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ]);
      expect(JSON.stringify(response.body)).not.toContain('maria');
      expect(JSON.stringify(response.body)).not.toContain('example.com');
    });

    it('expone solo { authorName, body, createdAt }: ignora cualquier dato extra del store', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();
      vi.mocked(reviewStore.listMatchReviews).mockResolvedValueOnce({
        items: [
          {
            authorName: 'Ana',
            body: 'Hola',
            createdAt: '2026-11-01T10:00:00.000Z',
            userId: U1,
            email: 'ana@example.com',
            rating: 5,
          } as never,
        ],
        nextCursor: null,
      });

      const response = await list(app);

      expect(Object.keys(response.body.reviews[0]).sort()).toEqual([
        'authorName',
        'body',
        'createdAt',
      ]);
      for (const secret of [U1, 'ana@example.com', 'userId', 'email', 'rating']) {
        expect(JSON.stringify(response.body)).not.toContain(secret);
      }
    });

    it('no revela ids de cuenta ni notas, ni siquiera en el cursor en claro', async () => {
      mockAuthenticated();
      const { app, ratingStore } = buildTestApp({
        reviewsByUser: { [U1]: at(1, 'Uno'), [U2]: at(2, 'Dos'), [U3]: at(3, 'Tres') },
        rating: 5,
      });

      const response = await list(app, '?limit=1');
      const serialized = JSON.stringify(response.body);

      expect(response.body.nextCursor).toEqual(expect.any(String));
      for (const id of [U1, U2, U3]) expect(serialized).not.toContain(id);
      expect(serialized).not.toMatch(/user_?id|email|rating/i);
      expect(ratingStore.findRating).not.toHaveBeenCalled();
    });

    it('ningún cursor, ya decodificado de base64url, deja ver el id de cuenta de un autor', async () => {
      const ids = [U1, U2, U3];
      const { app } = buildTestApp({
        reviewsByUser: { [U1]: at(1, 'Uno'), [U2]: at(2, 'Dos'), [U3]: at(3, 'Tres') },
      });
      const cursors: string[] = [];
      let cursor: string | null = null;

      // Recorre con limit=1 y junta cada cursor, como lo haría cualquier usuario autenticado.
      for (let guard = 0; guard < 10; guard++) {
        mockAuthenticated();
        const suffix: string = cursor ? `&cursor=${cursor}` : '';
        const response = await list(app, `?limit=1${suffix}`);
        cursor = response.body.nextCursor;
        if (cursor === null) break;
        cursors.push(cursor);
      }

      expect(cursors).toHaveLength(2);
      for (const token of cursors) {
        const decoded = Buffer.from(token, 'base64url');
        for (const id of ids) {
          expect(decoded.toString('utf8')).not.toContain(id);
          expect(decoded.toString('latin1')).not.toContain(id);
          expect(decoded.toString('hex')).not.toContain(Buffer.from(id).toString('hex'));
        }
        expect(() => JSON.parse(decoded.toString('utf8'))).toThrow();
      }
    });
  });

  describe('paginación', () => {
    const FIVE = {
      [U1]: at(1, 'r1'),
      [U2]: at(2, 'r2'),
      [U3]: at(3, 'r3'),
      [U4]: at(4, 'r4'),
      [U5]: at(5, 'r5'),
    };

    it('recorre todas las páginas sin repetir ni saltear reseñas, siempre en el mismo orden', async () => {
      const { app } = buildTestApp({ reviewsByUser: FIVE });

      expect(await walk(app, 2)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
      expect(await walk(app, 2)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
      expect(await walk(app, 1)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    });

    it('la última página no trae cursor, y una página exacta tampoco', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app } = buildTestApp({ reviewsByUser: FIVE });

      const exact = await list(app, '?limit=5');
      const more = await list(app, '?limit=4');

      expect(exact.body.reviews).toHaveLength(5);
      expect(exact.body.nextCursor).toBeNull();
      expect(more.body.reviews).toHaveLength(4);
      expect(more.body.nextCursor).toEqual(expect.any(String));
    });

    it('con empates de fecha el orden y las páginas son estables', async () => {
      const sameInstant = (body: string): MatchReview => ({
        body,
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      });
      const { app } = buildTestApp({
        reviewsByUser: {
          [U1]: sameInstant('t1'),
          [U2]: sameInstant('t2'),
          [U3]: sameInstant('t3'),
          [U4]: sameInstant('t4'),
        },
      });

      expect(await walk(app, 1)).toEqual(['t4', 't3', 't2', 't1']);
      expect(await walk(app, 3)).toEqual(['t4', 't3', 't2', 't1']);
    });

    it('pasa al store el cursor decodificado y el límite pedido', async () => {
      mockAuthenticated();
      const { app, reviewStore, cursorCodec } = buildTestApp();
      const cursor = { createdAt: '2026-11-01T10:00:00.123456+00:00', userId: U2 };

      const response = await list(app, `?limit=7&cursor=${cursorCodec.encode(cursor)}`);

      expect(response.status).toBe(200);
      expect(reviewStore.listMatchReviews).toHaveBeenCalledWith(MATCH_ID, {
        limit: 7,
        after: cursor,
      });
    });

    it.each([
      ['un cursor viejo en base64url con el user_id en claro', 'legacy'],
      ['un cursor alterado', 'tampered'],
      ['un cursor cifrado con otra clave', 'other-key'],
    ])('rechaza %s con 400 y no toca el store', async (_label, kind) => {
      mockAuthenticated();
      const { app, reviewStore, cursorCodec } = buildTestApp();
      const cursor = { createdAt: '2026-11-01T10:00:00.123456+00:00', userId: U2 };
      const token = {
        legacy: Buffer.from(JSON.stringify({ c: cursor.createdAt, u: cursor.userId })).toString(
          'base64url',
        ),
        tampered: (() => {
          const raw = Buffer.from(cursorCodec.encode(cursor), 'base64url');
          raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01;
          return raw.toString('base64url');
        })(),
        'other-key': createReviewsCursorCodec('otro-secreto-distinto-de-32-caracteres').encode(
          cursor,
        ),
      }[kind as 'legacy' | 'tampered' | 'other-key'];

      const response = await list(app, `?cursor=${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(reviewStore.listMatchReviews).not.toHaveBeenCalled();
    });

    it('acepta limit 1 y 50 como extremos', async () => {
      mockAuthenticated();
      mockAuthenticated();
      const { app } = buildTestApp();

      expect((await list(app, '?limit=1')).status).toBe(200);
      expect((await list(app, '?limit=50')).status).toBe(200);
    });
  });

  describe('borrado', () => {
    it('una reseña eliminada deja de aparecer en el listado', async () => {
      mockAuthenticated(U1);
      mockAuthenticated(U1);
      mockAuthenticated(U3);
      const { app } = buildTestApp({
        reviewsByUser: { [U1]: at(1, 'Se borra'), [U2]: at(2, 'Queda') },
        profileNames: { [U1]: 'Ana', [U2]: 'Beto' },
      });

      const before = await list(app);
      const removed = await request(app).delete(URL).set('Authorization', 'Bearer good');
      const after = await list(app);

      expect(before.body.reviews.map((r: { body: string }) => r.body)).toEqual([
        'Queda',
        'Se borra',
      ]);
      expect(removed.status).toBe(200);
      expect(after.body.reviews.map((r: { body: string }) => r.body)).toEqual(['Queda']);
    });
  });

  describe('validación y errores', () => {
    it('id de partido inválido responde 400 VALIDATION_ERROR y no consulta', async () => {
      mockAuthenticated();
      const { app, catalog, reviewStore } = buildTestApp();

      const response = await list(app, '', '/matches/no-es-uuid/reviews');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(catalog.findById).not.toHaveBeenCalled();
      expect(reviewStore.listMatchReviews).not.toHaveBeenCalled();
    });

    it.each([
      ['limit 0', '?limit=0'],
      ['limit 51', '?limit=51'],
      ['limit negativo', '?limit=-1'],
      ['limit decimal', '?limit=2.5'],
      ['limit no numérico', '?limit=abc'],
      ['limit vacío', '?limit='],
      ['limit repetido', '?limit=1&limit=2'],
      ['cursor repetido', '?cursor=a&cursor=b'],
      ['cursor que no es un cursor', '?cursor=hola'],
      ['cursor vacío', '?cursor='],
      ['cursor con un user_id suelto', `?cursor=${U1}`],
    ])('%s responde 400 y no consulta el store', async (_label, query) => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({ reviewsByUser: { [U1]: at(1, 'x') } });

      const response = await list(app, query);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(reviewStore.listMatchReviews).not.toHaveBeenCalled();
    });

    it('partido inexistente responde 404 NOT_FOUND y no lista', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp({
        matchExists: false,
        reviewsByUser: { [U1]: at(1, 'x') },
      });

      const response = await list(app);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(reviewStore.listMatchReviews).not.toHaveBeenCalled();
    });

    it('lista aunque el partido no esté finalizado y sin importar el visto o la nota del lector', async () => {
      mockAuthenticated();
      const { app } = buildTestApp({
        status: 'live',
        watched: false,
        rating: null,
        reviewsByUser: { [U1]: at(1, 'x') },
      });

      expect((await list(app)).status).toBe(200);
    });

    it('un fallo de persistencia responde 500 genérico, sin detalles ni lista vacía', async () => {
      mockAuthenticated();
      const { app, reviewStore } = buildTestApp();
      vi.mocked(reviewStore.listMatchReviews).mockRejectedValueOnce(
        new MatchReviewPersistenceError('No se pudo listar.', {
          message: 'password=secreto host=db.interno',
        }),
      );

      const response = await list(app);

      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('reviews');
      expect(JSON.stringify(response.body)).not.toContain('secreto');
      expect(JSON.stringify(response.body)).not.toContain('db.interno');
    });
  });
});
