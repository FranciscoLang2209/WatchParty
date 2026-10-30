import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWatchedHistoryRouter } from './watched-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type {
  ListWatchedHistoryPageOptions,
  WatchedHistoryPage,
  WatchedMatchStore,
} from '../domain/watched-match-store.js';
import { WatchedMatchPersistenceError } from '../infrastructure/watched-match-persistence-error.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
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

type ListHistoryPage = (
  userId: string,
  options: ListWatchedHistoryPageOptions,
) => Promise<WatchedHistoryPage>;

function buildTestApp(listHistoryPage: ListHistoryPage): Express {
  const store: WatchedMatchStore = {
    setWatched: vi.fn(),
    getWatched: vi.fn(),
    listHistoryPage,
  };
  const app = express();

  app.use(express.json());
  app.use('/me', createWatchedHistoryRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const URL = '/me/watched-matches';
const MATCH_ID = 'a1111111-1111-4111-8111-111111111111';
const CURSOR_WATCHED_AT = '2026-10-10T12:00:00.123456+00:00';
const TEAM_ID = 'b1111111-1111-4111-8111-111111111111';

const PAGE: WatchedHistoryPage = {
  items: [
    {
      match: {
        id: MATCH_ID,
        homeTeam: 'Boca Juniors',
        homeTeamId: 'team-boca',
        awayTeam: 'River Plate',
        awayTeamId: 'team-river',
        kickoffAt: '2026-10-05T21:00:00.000Z',
        status: 'finished',
        score: { home: 2, away: 1 },
      },
      watchedAt: '2026-10-10T12:00:00.123Z',
      rating: 4,
    },
  ],
  nextCursor: { watchedAt: CURSOR_WATCHED_AT, matchId: MATCH_ID },
};

const EMPTY_PAGE: WatchedHistoryPage = { items: [], nextCursor: null };

describe('GET /me/watched-matches', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido pide la primera página del usuario del bearer con el límite por defecto', async () => {
    mockAuthenticated('user-123');
    const listHistoryPage = vi.fn<ListHistoryPage>(async () => PAGE);
    const app = buildTestApp(listHistoryPage);

    const response = await request(app).get(URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(listHistoryPage).toHaveBeenCalledWith('user-123', { limit: 20 });
    expect(response.body).toEqual({
      items: [
        {
          match: {
            id: MATCH_ID,
            homeTeam: 'Boca Juniors',
            homeTeamId: 'team-boca',
            awayTeam: 'River Plate',
            awayTeamId: 'team-river',
            kickoffAt: '2026-10-05T21:00:00.000Z',
            status: 'finished',
            score: { home: 2, away: 1 },
          },
          watchedAt: '2026-10-10T12:00:00.123Z',
          rating: 4,
        },
      ],
      nextCursor: { watchedAt: CURSOR_WATCHED_AT, matchId: MATCH_ID },
    });
  });

  it('conserva los campos previos de cada item y solo agrega rating', async () => {
    mockAuthenticated();
    const app = buildTestApp(vi.fn<ListHistoryPage>(async () => PAGE));

    const response = await request(app).get(URL).set('Authorization', 'Bearer good-token');

    expect(Object.keys(response.body)).toEqual(['items', 'nextCursor']);
    expect(Object.keys(response.body.items[0])).toEqual(['match', 'watchedAt', 'rating']);
  });

  it('un partido sin calificar viaja con rating null explícito, no omitido', async () => {
    mockAuthenticated();
    const unrated: WatchedHistoryPage = {
      items: [{ ...PAGE.items[0]!, rating: null }],
      nextCursor: null,
    };
    const app = buildTestApp(vi.fn<ListHistoryPage>(async () => unrated));

    const response = await request(app).get(URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toHaveProperty('rating', null);
  });

  it('un usuario sin vistos recibe 200 con items vacíos y nextCursor null', async () => {
    mockAuthenticated();
    const app = buildTestApp(vi.fn<ListHistoryPage>(async () => EMPTY_PAGE));

    const response = await request(app).get(URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('pasa limit y el cursor al store', async () => {
    mockAuthenticated('user-123');
    const listHistoryPage = vi.fn<ListHistoryPage>(async () => EMPTY_PAGE);
    const app = buildTestApp(listHistoryPage);

    const response = await request(app)
      .get(URL)
      .query({ limit: '5', beforeWatchedAt: CURSOR_WATCHED_AT, beforeMatchId: MATCH_ID })
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(listHistoryPage).toHaveBeenCalledWith('user-123', {
      limit: 5,
      before: { watchedAt: CURSOR_WATCHED_AT, matchId: MATCH_ID },
    });
  });

  it('pasa teamId al store junto con limit y el cursor', async () => {
    mockAuthenticated('user-123');
    const listHistoryPage = vi.fn<ListHistoryPage>(async () => EMPTY_PAGE);
    const app = buildTestApp(listHistoryPage);

    const response = await request(app)
      .get(URL)
      .query({
        teamId: TEAM_ID,
        limit: '5',
        beforeWatchedAt: CURSOR_WATCHED_AT,
        beforeMatchId: MATCH_ID,
      })
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(listHistoryPage).toHaveBeenCalledWith('user-123', {
      limit: 5,
      before: { watchedAt: CURSOR_WATCHED_AT, matchId: MATCH_ID },
      teamId: TEAM_ID,
    });
  });

  it('con teamId sin coincidencias responde 200 con items vacíos', async () => {
    mockAuthenticated('user-123');
    const listHistoryPage = vi.fn<ListHistoryPage>(async () => EMPTY_PAGE);
    const app = buildTestApp(listHistoryPage);

    const response = await request(app)
      .get(URL)
      .query({ teamId: TEAM_ID })
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
    expect(listHistoryPage).toHaveBeenCalledWith('user-123', { limit: 20, teamId: TEAM_ID });
  });

  it('ignora un userId enviado en la query: lista solo los vistos del bearer', async () => {
    mockAuthenticated('user-123');
    const listHistoryPage = vi.fn<ListHistoryPage>(async () => EMPTY_PAGE);
    const app = buildTestApp(listHistoryPage);

    await request(app)
      .get(URL)
      .query({ userId: 'otro-usuario' })
      .set('Authorization', 'Bearer good-token');

    expect(listHistoryPage).toHaveBeenCalledWith('user-123', { limit: 20 });
  });

  it('sin token responde 401 UNAUTHORIZED y no invoca el store', async () => {
    const listHistoryPage = vi.fn<ListHistoryPage>();
    const app = buildTestApp(listHistoryPage);

    const response = await request(app).get(URL);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(listHistoryPage).not.toHaveBeenCalled();
  });

  it('con token inválido responde 401 y no invoca el store', async () => {
    mockInvalidToken();
    const listHistoryPage = vi.fn<ListHistoryPage>();
    const app = buildTestApp(listHistoryPage);

    const response = await request(app).get(URL).set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(listHistoryPage).not.toHaveBeenCalled();
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['limit por encima del máximo', { limit: '51' }],
    ['limit no numérico', { limit: 'abc' }],
    ['limit decimal', { limit: '2.5' }],
    ['limit repetido', 'limit=1&limit=2'],
    ['cursor sin beforeMatchId', { beforeWatchedAt: CURSOR_WATCHED_AT }],
    ['cursor sin beforeWatchedAt', { beforeMatchId: MATCH_ID }],
    ['beforeWatchedAt mal formado', { beforeWatchedAt: 'ayer', beforeMatchId: MATCH_ID }],
    [
      'beforeWatchedAt que intenta inyectar un filtro',
      { beforeWatchedAt: `${CURSOR_WATCHED_AT},user_id.neq.x`, beforeMatchId: MATCH_ID },
    ],
    [
      'beforeWatchedAt con una fecha inexistente',
      { beforeWatchedAt: '2026-02-30T12:00:00Z', beforeMatchId: MATCH_ID },
    ],
    [
      'beforeWatchedAt con una hora inexistente',
      { beforeWatchedAt: '2026-10-10T24:00:00.123456+00:00', beforeMatchId: MATCH_ID },
    ],
    ['beforeMatchId que no es UUID', { beforeWatchedAt: CURSOR_WATCHED_AT, beforeMatchId: 'x' }],
    ['teamId que no es UUID', { teamId: 'boca' }],
    ['teamId vacío', { teamId: '' }],
    ['teamId que intenta inyectar un filtro', { teamId: `${TEAM_ID},user_id.neq.x` }],
    ['teamId repetido', `teamId=${TEAM_ID}&teamId=${TEAM_ID}`],
  ])('con %s responde 400 VALIDATION_ERROR y no invoca el store', async (_label, query) => {
    mockAuthenticated();
    const listHistoryPage = vi.fn<ListHistoryPage>();
    const app = buildTestApp(listHistoryPage);

    const response = await request(app)
      .get(URL)
      .query(query)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(listHistoryPage).not.toHaveBeenCalled();
  });

  it('acepta el límite máximo', async () => {
    mockAuthenticated('user-123');
    const listHistoryPage = vi.fn<ListHistoryPage>(async () => EMPTY_PAGE);
    const app = buildTestApp(listHistoryPage);

    const response = await request(app)
      .get(URL)
      .query({ limit: '50' })
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(listHistoryPage).toHaveBeenCalledWith('user-123', { limit: 50 });
  });

  it('un error de persistencia responde 500 genérico, no una lista vacía, sin filtrar detalles', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      vi.fn<ListHistoryPage>(async () => {
        throw new WatchedMatchPersistenceError(
          'No se pudo listar el historial.',
          new Error('relation "watched_matches" does not exist'),
        );
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app).get(URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('watched_matches');
  });

  it('un error al leer las notas responde 500 genérico, no items sin calificar', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      vi.fn<ListHistoryPage>(async () => {
        throw new WatchedMatchPersistenceError(
          'No se pudieron leer las notas del historial de vistos.',
          new Error('permission denied for table match_ratings'),
        );
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app).get(URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('match_ratings');
  });
});
