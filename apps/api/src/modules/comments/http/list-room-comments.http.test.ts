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

  app.use('/rooms', createCommentsRouter(store));
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
