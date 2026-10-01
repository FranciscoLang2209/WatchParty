import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCommentsRouter } from './comments-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type {
  RoomCommentReactionState,
  RoomCommentReactionStore,
  SetRoomCommentReactionInput,
} from '../domain/room-comment-reaction-store.js';
import { RoomCommentPersistenceError } from '../infrastructure/room-comment-persistence-error.js';

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

type SetReaction = (input: SetRoomCommentReactionInput) => Promise<RoomCommentReactionState | null>;

function buildStore(setReaction: SetReaction): RoomCommentReactionStore {
  return { setReaction };
}

function buildTestApp(reactionStore: RoomCommentReactionStore) {
  const app = express();

  app.use(express.json());
  // Las rutas de comentarios y de reacción comparten router: los stores de
  // comentarios no se usan acá, así que alcanza un doble vacío.
  app.use(
    '/rooms',
    createCommentsRouter(
      {
        listByRoom: async () => [],
        listPageByRoom: async () => ({ items: [], nextCursor: null }),
        create: async () => null,
      },
      reactionStore,
    ),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Los dos verbos se llaman igual; solo cambia el método HTTP. */
function send(app: Express, verb: 'put' | 'delete', url: string) {
  return request(app)[verb](url);
}

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

const URL = `/rooms/${ROOM_ID}/comments/${COMMENT_ID}/reaction`;

// Los dos verbos comparten handler: se prueban con la misma tabla, y lo único
// que cambia es el estado deseado que el store debe recibir.
const VERBS = [
  ['PUT', 'put', true],
  ['DELETE', 'delete', false],
] as const;

describe.each(VERBS)('%s /rooms/:roomId/comments/:commentId/reaction', (_label, verb, reacted) => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it(`con token válido llama al store con reacted: ${reacted} y responde 200 con { reaction }`, async () => {
    mockAuthenticated();
    const setReaction = vi.fn<SetReaction>(async () => ({ count: 3, reacted }));
    const app = buildTestApp(buildStore(setReaction));

    const response = await send(app, verb, URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reaction: { count: 3, reacted } });
    expect(Object.keys(response.body.reaction).sort()).toEqual(['count', 'reacted']);
    // El usuario sale del token, nunca de la petición.
    expect(setReaction).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      commentId: COMMENT_ID,
      userId: 'user-123',
      reacted,
    });
  });

  it('ignora un userId o un reacted enviados en el body', async () => {
    mockAuthenticated('user-123');
    const setReaction = vi.fn<SetReaction>(async () => ({ count: 1, reacted }));
    const app = buildTestApp(buildStore(setReaction));

    const response = await send(app, verb, URL)
      .set('Authorization', 'Bearer good-token')
      .send({ userId: 'otro-usuario', reacted: !reacted });

    expect(response.status).toBe(200);
    expect(setReaction).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      commentId: COMMENT_ID,
      userId: 'user-123',
      reacted,
    });
  });

  it('sin token responde 401 UNAUTHORIZED y no invoca el store', async () => {
    const setReaction = vi.fn<SetReaction>();
    const app = buildTestApp(buildStore(setReaction));

    const response = await send(app, verb, URL);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('con token inválido responde 401 y no invoca el store', async () => {
    mockInvalidToken();
    const setReaction = vi.fn<SetReaction>();
    const app = buildTestApp(buildStore(setReaction));

    const response = await send(app, verb, URL).set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('sin token y con ids inválidos responde 401, no 400: la autenticación va primero', async () => {
    const setReaction = vi.fn<SetReaction>();
    const app = buildTestApp(buildStore(setReaction));

    const response = await send(app, verb, '/rooms/no-uuid/comments/no-uuid/reaction');

    expect(response.status).toBe(401);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it.each([
    ['roomId', `/rooms/no-es-uuid/comments/${COMMENT_ID}/reaction`],
    ['commentId', `/rooms/${ROOM_ID}/comments/no-es-uuid/reaction`],
  ])(
    'con %s inválido responde 400 VALIDATION_ERROR y no invoca el store',
    async (_field, invalidUrl) => {
      mockAuthenticated();
      const setReaction = vi.fn<SetReaction>();
      const app = buildTestApp(buildStore(setReaction));

      const response = await send(app, verb, invalidUrl).set('Authorization', 'Bearer good-token');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
      expect(setReaction).not.toHaveBeenCalled();
    },
  );

  it('responde 404 NOT_FOUND si el store devuelve null (sala o comentario inexistente)', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore(async () => null));

    const response = await send(app, verb, URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('un error de persistencia responde 500 genérico sin filtrar detalles internos', async () => {
    mockAuthenticated();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildTestApp(
      buildStore(async () => {
        throw new RoomCommentPersistenceError('No se pudo marcar el Me gusta.', {
          message: 'detalle interno de postgres',
        });
      }),
    );

    const response = await send(app, verb, URL).set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.text).not.toContain('detalle interno');
    expect(response.text).not.toContain('No se pudo marcar');

    consoleError.mockRestore();
  });
});

describe('reacciones de dos usuarios sobre el mismo comentario', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  // Store en memoria con la semántica del puerto: una reacción por usuario,
  // idempotente, y el conteo es el total de usuarios que reaccionaron.
  function buildStatefulStore() {
    const reactedUsers = new Set<string>();

    return {
      reactedUsers,
      store: buildStore(async ({ userId, reacted }) => {
        if (reacted) reactedUsers.add(userId);
        else reactedUsers.delete(userId);

        return { count: reactedUsers.size, reacted };
      }),
    };
  }

  it('cada bearer mueve solo su propia reacción y el conteo refleja a ambos', async () => {
    const { store, reactedUsers } = buildStatefulStore();
    const app = buildTestApp(store);

    mockAuthenticated('user-a');
    const aMarks = await request(app).put(URL).set('Authorization', 'Bearer token-a');

    mockAuthenticated('user-b');
    const bMarks = await request(app).put(URL).set('Authorization', 'Bearer token-b');

    expect(aMarks.body).toEqual({ reaction: { count: 1, reacted: true } });
    expect(bMarks.body).toEqual({ reaction: { count: 2, reacted: true } });

    mockAuthenticated('user-a');
    const aUnmarks = await request(app).delete(URL).set('Authorization', 'Bearer token-a');

    expect(aUnmarks.body).toEqual({ reaction: { count: 1, reacted: false } });
    // Quitar la reacción de A no tocó la de B.
    expect([...reactedUsers]).toEqual(['user-b']);
  });

  it('repetir PUT y repetir DELETE es idempotente', async () => {
    const { store } = buildStatefulStore();
    const app = buildTestApp(store);

    mockAuthenticated('user-a');
    await request(app).put(URL).set('Authorization', 'Bearer token-a');
    mockAuthenticated('user-a');
    const secondPut = await request(app).put(URL).set('Authorization', 'Bearer token-a');

    mockAuthenticated('user-a');
    await request(app).delete(URL).set('Authorization', 'Bearer token-a');
    mockAuthenticated('user-a');
    const secondDelete = await request(app).delete(URL).set('Authorization', 'Bearer token-a');

    expect(secondPut.body).toEqual({ reaction: { count: 1, reacted: true } });
    expect(secondDelete.body).toEqual({ reaction: { count: 0, reacted: false } });
  });
});
