import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCommentsRouter } from './comments-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { RoomCommentStore } from '../domain/room-comment-store.js';
import type { RoomComment } from '../domain/room-comment.js';

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

function buildStore(overrides: Partial<RoomCommentStore> = {}): RoomCommentStore {
  return {
    listByRoom: async () => [],
    listPageByRoom: async () => ({ items: [], nextCursor: null }),
    create: async (input) => ({
      id: 'comment-1',
      roomId: input.roomId,
      body: input.body,
      createdAt: '2026-09-19T12:00:00.000Z',
    }),
    ...overrides,
  };
}

function buildTestApp(store: RoomCommentStore) {
  const app = express();

  app.use('/rooms', createCommentsRouter(store, { setReaction: async () => null }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const ROOM_ID = 'room-1';

const COMMENT: RoomComment = {
  id: 'comment-1',
  roomId: ROOM_ID,
  body: 'Qué golazo',
  createdAt: '2026-09-19T12:00:00.000Z',
};

describe('GET /rooms/:roomId/comments', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido responde 200 con los comentarios de la sala', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ listByRoom: async () => [COMMENT] }));

    const response = await request(app)
      .get(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ comments: [COMMENT] });
    expect(Object.keys(response.body.comments[0]).sort()).toEqual(
      ['id', 'roomId', 'body', 'createdAt'].sort(),
    );
  });

  it('una sala real sin comentarios responde 200 con lista vacía, no 404', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ listByRoom: async () => [] }));

    const response = await request(app)
      .get(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ comments: [] });
  });

  it('sin token no invoca el store y responde 401 UNAUTHORIZED', async () => {
    const listByRoom = vi.fn();
    const app = buildTestApp(buildStore({ listByRoom }));

    const response = await request(app).get(`/rooms/${ROOM_ID}/comments`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(listByRoom).not.toHaveBeenCalled();
  });

  // El resto de la matriz de 401 (esquema distinto de Bearer, Bearer vacío,
  // token inválido) prueba requireAuthenticatedUser, no este handler: ya está
  // cubierta a fondo en get-match.http.test.ts contra el mismo middleware.
  // Acá alcanza con un caso negativo representativo.
  it('con un token inválido no invoca el store y responde 401 UNAUTHORIZED', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);

    const listByRoom = vi.fn();
    const app = buildTestApp(buildStore({ listByRoom }));

    const response = await request(app)
      .get(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(listByRoom).not.toHaveBeenCalled();
  });

  it('una sala inexistente responde 404 NOT_FOUND', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ listByRoom: async () => null }));

    const response = await request(app)
      .get(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('un fallo no controlado del store responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      buildStore({
        listByRoom: async () => {
          throw new Error('detalle interno de base de datos');
        },
      }),
    );

    const response = await request(app)
      .get(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });
});

describe('GET /rooms/:roomId/comments con paginación por cursor (WAT-174)', () => {
  const CURSOR_ID = '11111111-1111-4111-8111-111111111111';
  const CURSOR_AT = '2026-09-19T12:00:00.123456+00:00';
  const NEXT_CURSOR = { createdAt: '2026-09-19T12:05:00.654321+00:00', id: CURSOR_ID };

  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  function get(app: ReturnType<typeof buildTestApp>, query: string) {
    return request(app)
      .get(`/rooms/${ROOM_ID}/comments${query}`)
      .set('Authorization', 'Bearer good-token');
  }

  it('sin parámetros usa listByRoom y no incluye nextCursor (compatibilidad)', async () => {
    mockAuthenticated();
    const listByRoom = vi.fn(async () => [COMMENT]);
    const listPageByRoom = vi.fn();
    const app = buildTestApp(buildStore({ listByRoom, listPageByRoom }));

    const response = await get(app, '');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ comments: [COMMENT] });
    expect(listPageByRoom).not.toHaveBeenCalled();
  });

  it('con cursor completo y limit válido delega a listPageByRoom y responde comments + nextCursor', async () => {
    mockAuthenticated();
    const listPageByRoom = vi.fn(async () => ({ items: [COMMENT], nextCursor: NEXT_CURSOR }));
    const listByRoom = vi.fn();
    const app = buildTestApp(buildStore({ listByRoom, listPageByRoom }));

    const response = await get(
      app,
      `?beforeCreatedAt=${encodeURIComponent(CURSOR_AT)}&beforeId=${CURSOR_ID}&limit=20`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ comments: [COMMENT], nextCursor: NEXT_CURSOR });
    expect(listPageByRoom).toHaveBeenCalledWith(ROOM_ID, {
      limit: 20,
      after: { createdAt: CURSOR_AT, id: CURSOR_ID },
    });
    expect(listByRoom).not.toHaveBeenCalled();
  });

  it('en la última página responde nextCursor null', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      buildStore({ listPageByRoom: async () => ({ items: [COMMENT], nextCursor: null }) }),
    );

    const response = await get(
      app,
      `?beforeId=${CURSOR_ID}&beforeCreatedAt=${encodeURIComponent(CURSOR_AT)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ comments: [COMMENT], nextCursor: null });
  });

  it('con solo limit pide la primera página (sin after)', async () => {
    mockAuthenticated();
    const listPageByRoom = vi.fn(async () => ({ items: [COMMENT], nextCursor: NEXT_CURSOR }));
    const app = buildTestApp(buildStore({ listPageByRoom }));

    const response = await get(app, '?limit=5');

    expect(response.status).toBe(200);
    expect(listPageByRoom).toHaveBeenCalledWith(ROOM_ID, { limit: 5 });
  });

  it('con cursor y sin limit usa el límite máximo por defecto', async () => {
    mockAuthenticated();
    const listPageByRoom = vi.fn(async () => ({ items: [], nextCursor: null }));
    const app = buildTestApp(buildStore({ listPageByRoom }));

    await get(app, `?beforeCreatedAt=${encodeURIComponent(CURSOR_AT)}&beforeId=${CURSOR_ID}`);

    expect(listPageByRoom).toHaveBeenCalledWith(ROOM_ID, {
      limit: 100,
      after: { createdAt: CURSOR_AT, id: CURSOR_ID },
    });
  });

  const VALID_CURSOR = `beforeCreatedAt=${encodeURIComponent(CURSOR_AT)}&beforeId=${CURSOR_ID}`;

  it.each([
    ['limit no entero', `?${VALID_CURSOR}&limit=abc`],
    ['limit decimal', `?${VALID_CURSOR}&limit=1.5`],
    ['limit negativo', `?${VALID_CURSOR}&limit=-1`],
    ['limit cero', `?${VALID_CURSOR}&limit=0`],
    ['limit por encima del máximo', `?${VALID_CURSOR}&limit=101`],
    ['limit vacío', `?${VALID_CURSOR}&limit=`],
    ['limit repetido', `?${VALID_CURSOR}&limit=1&limit=2`],
    ['cursor sin beforeId', `?beforeCreatedAt=${encodeURIComponent(CURSOR_AT)}`],
    ['cursor sin beforeCreatedAt', `?beforeId=${CURSOR_ID}`],
    ['beforeCreatedAt inválido', `?beforeCreatedAt=ayer&beforeId=${CURSOR_ID}`],
    [
      'beforeCreatedAt con fecha imposible',
      `?beforeCreatedAt=${encodeURIComponent('2026-13-45T25:61:61Z')}&beforeId=${CURSOR_ID}`,
    ],
    ['beforeId inválido', `?beforeCreatedAt=${encodeURIComponent(CURSOR_AT)}&beforeId=no-es-uuid`],
    ['cursor repetido', `?${VALID_CURSOR}&beforeId=${CURSOR_ID}`],
  ])('%s responde 400 VALIDATION_ERROR sin consultar el store', async (_name, query) => {
    mockAuthenticated();
    const listByRoom = vi.fn();
    const listPageByRoom = vi.fn();
    const app = buildTestApp(buildStore({ listByRoom, listPageByRoom }));

    const response = await get(app, query);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    });
    expect(listByRoom).not.toHaveBeenCalled();
    expect(listPageByRoom).not.toHaveBeenCalled();
  });

  it('sin token responde 401 antes de procesar la paginación', async () => {
    const listByRoom = vi.fn();
    const listPageByRoom = vi.fn();
    const app = buildTestApp(buildStore({ listByRoom, listPageByRoom }));

    // limit inválido a propósito: si se validara antes que la auth, daría 400.
    const response = await request(app).get(`/rooms/${ROOM_ID}/comments?limit=abc`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(listByRoom).not.toHaveBeenCalled();
    expect(listPageByRoom).not.toHaveBeenCalled();
  });

  it('una sala inexistente en el camino paginado responde 404 NOT_FOUND', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ listPageByRoom: async () => null }));

    const response = await get(app, `?${VALID_CURSOR}&limit=10`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });
});
