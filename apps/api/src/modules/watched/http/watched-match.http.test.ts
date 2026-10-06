import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWatchedRouter } from './watched-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { WatchedMatchResult, WatchedMatchStore } from '../domain/watched-match-store.js';
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

type SetWatched = (
  userId: string,
  matchId: string,
  watched: boolean,
) => Promise<WatchedMatchResult | null>;

function buildTestApp(setWatched: SetWatched): Express {
  const store: WatchedMatchStore = { setWatched };
  const app = express();

  app.use(express.json());
  app.use('/matches', createWatchedRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Los dos verbos se llaman igual; solo cambia el método HTTP. */
function send(app: Express, verb: 'put' | 'delete', url: string) {
  return request(app)[verb](url);
}

const MATCH_ID = 'a1111111-1111-4111-8111-111111111111';
const URL = `/matches/${MATCH_ID}/watched`;

// Los dos verbos comparten handler: se prueban con la misma tabla, y lo único
// que cambia es el estado deseado que el store debe recibir.
const VERBS = [
  ['PUT', 'put', true],
  ['DELETE', 'delete', false],
] as const;

describe.each(VERBS)('%s /matches/:matchId/watched', (_label, verb, watched) => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it(`con token válido llama al store con watched: ${watched} y responde 200 con { watched }`, async () => {
    mockAuthenticated();
    const setWatched = vi.fn<SetWatched>(async (_userId, matchId) => ({ matchId, watched }));
    const app = buildTestApp(setWatched);

    const response = await send(app, verb, URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ watched });
    // El usuario sale del token, nunca de la petición.
    expect(setWatched).toHaveBeenCalledWith('user-123', MATCH_ID, watched);
  });

  it('ignora un userId o un watched enviados en el body y en la query', async () => {
    mockAuthenticated('user-123');
    const setWatched = vi.fn<SetWatched>(async (_userId, matchId) => ({ matchId, watched }));
    const app = buildTestApp(setWatched);

    const response = await send(app, verb, `${URL}?userId=otro-usuario&watched=${!watched}`)
      .set('Authorization', 'Bearer good-token')
      .send({ userId: 'otro-usuario', watched: !watched });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ watched });
    expect(setWatched).toHaveBeenCalledWith('user-123', MATCH_ID, watched);
  });

  it('sin token responde 401 UNAUTHORIZED y no invoca el store', async () => {
    const setWatched = vi.fn<SetWatched>();
    const app = buildTestApp(setWatched);

    const response = await send(app, verb, URL);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(setWatched).not.toHaveBeenCalled();
  });

  it('con token inválido responde 401 y no invoca el store', async () => {
    mockInvalidToken();
    const setWatched = vi.fn<SetWatched>();
    const app = buildTestApp(setWatched);

    const response = await send(app, verb, URL).set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(setWatched).not.toHaveBeenCalled();
  });

  it('sin token y con id inválido responde 401, no 400: la autenticación va primero', async () => {
    const setWatched = vi.fn<SetWatched>();
    const app = buildTestApp(setWatched);

    const response = await send(app, verb, '/matches/no-es-uuid/watched');

    expect(response.status).toBe(401);
    expect(setWatched).not.toHaveBeenCalled();
  });

  it('con matchId inválido responde 400 VALIDATION_ERROR y no invoca el store', async () => {
    mockAuthenticated();
    const setWatched = vi.fn<SetWatched>();
    const app = buildTestApp(setWatched);

    const response = await send(app, verb, '/matches/no-es-uuid/watched').set(
      'Authorization',
      'Bearer good-token',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    });
    expect(setWatched).not.toHaveBeenCalled();
  });

  it('responde 404 NOT_FOUND si el store devuelve null (partido inexistente)', async () => {
    mockAuthenticated();
    const app = buildTestApp(async () => null);

    const response = await send(app, verb, URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('un error de persistencia responde 500 genérico sin filtrar detalles internos', async () => {
    mockAuthenticated();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildTestApp(async () => {
      throw new WatchedMatchPersistenceError('No se pudo marcar el partido como visto.', {
        message: 'detalle interno de postgres',
      });
    });

    const response = await send(app, verb, URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.text).not.toContain('detalle interno');
    expect(response.text).not.toContain('No se pudo marcar');

    consoleError.mockRestore();
  });
});

describe('partido visto de dos usuarios sobre el mismo partido', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  // Store en memoria con la semántica del puerto: una relación por
  // (usuario, partido), idempotente en ambos sentidos.
  function buildStatefulStore() {
    const watchedBy = new Set<string>();

    return {
      watchedBy,
      setWatched: (async (userId, matchId, watched) => {
        if (watched) watchedBy.add(userId);
        else watchedBy.delete(userId);

        return { matchId, watched };
      }) as SetWatched,
    };
  }

  it('cada bearer mueve solo su propia relación', async () => {
    const { setWatched, watchedBy } = buildStatefulStore();
    const app = buildTestApp(setWatched);

    mockAuthenticated('user-a');
    await request(app).put(URL).set('Authorization', 'Bearer token-a');
    mockAuthenticated('user-b');
    await request(app).put(URL).set('Authorization', 'Bearer token-b');

    expect([...watchedBy].sort()).toEqual(['user-a', 'user-b']);

    mockAuthenticated('user-a');
    const aUnmarks = await request(app).delete(URL).set('Authorization', 'Bearer token-a');

    expect(aUnmarks.body).toEqual({ watched: false });
    // Deshacer el visto de A no tocó el de B.
    expect([...watchedBy]).toEqual(['user-b']);
  });

  it('repetir PUT y repetir DELETE devuelve el mismo estado final sin error', async () => {
    const { setWatched } = buildStatefulStore();
    const app = buildTestApp(setWatched);

    mockAuthenticated('user-a');
    await request(app).put(URL).set('Authorization', 'Bearer token-a');
    mockAuthenticated('user-a');
    const secondPut = await request(app).put(URL).set('Authorization', 'Bearer token-a');

    mockAuthenticated('user-a');
    await request(app).delete(URL).set('Authorization', 'Bearer token-a');
    mockAuthenticated('user-a');
    const secondDelete = await request(app).delete(URL).set('Authorization', 'Bearer token-a');

    expect(secondPut.status).toBe(200);
    expect(secondPut.body).toEqual({ watched: true });
    expect(secondDelete.status).toBe(200);
    expect(secondDelete.body).toEqual({ watched: false });
  });
});
