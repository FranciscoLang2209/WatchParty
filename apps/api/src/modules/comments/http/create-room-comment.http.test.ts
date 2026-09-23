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

  app.use(express.json());
  app.use('/rooms', createCommentsRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const ROOM_ID = 'room-1';

const VALID_BODY = {
  body: 'Qué golazo',
  clientRequestId: '11111111-1111-1111-1111-111111111111',
};

const CREATED_COMMENT: RoomComment = {
  id: 'comment-1',
  roomId: ROOM_ID,
  body: VALID_BODY.body,
  createdAt: '2026-09-19T12:00:00.000Z',
};

describe('POST /rooms/:roomId/comments', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con body válido crea el comentario y responde 201', async () => {
    mockAuthenticated();
    const create = vi.fn(async () => CREATED_COMMENT);
    const app = buildTestApp(buildStore({ create }));

    const response = await request(app)
      .post(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token')
      .send(VALID_BODY);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ comment: CREATED_COMMENT });
    expect(Object.keys(response.body.comment).sort()).toEqual(
      ['id', 'roomId', 'body', 'createdAt'].sort(),
    );
    // El autor sale del token, nunca de un campo que el cliente pueda mandar.
    expect(create).toHaveBeenCalledWith(
      { roomId: ROOM_ID, body: VALID_BODY.body, clientRequestId: VALID_BODY.clientRequestId },
      'user-123',
    );
  });

  it('el body se recorta antes de guardarse', async () => {
    mockAuthenticated();
    const create = vi.fn(async () => CREATED_COMMENT);
    const app = buildTestApp(buildStore({ create }));

    await request(app)
      .post(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token')
      .send({ ...VALID_BODY, body: `  ${VALID_BODY.body}  ` });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ body: VALID_BODY.body }),
      'user-123',
    );
  });

  it('sin token no invoca el store y responde 401 UNAUTHORIZED', async () => {
    const create = vi.fn();
    const app = buildTestApp(buildStore({ create }));

    const response = await request(app).post(`/rooms/${ROOM_ID}/comments`).send(VALID_BODY);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(create).not.toHaveBeenCalled();
  });

  // Igual que en list-room-comments.http.test.ts: el resto de la matriz de
  // 401 prueba requireAuthenticatedUser, ya cubierta en get-match.http.test.ts.
  it('con un token inválido no invoca el store y responde 401 UNAUTHORIZED', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);

    const create = vi.fn();
    const app = buildTestApp(buildStore({ create }));

    const response = await request(app)
      .post(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer bad-token')
      .send(VALID_BODY);

    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['falta un campo', { body: VALID_BODY.body }],
    ['tiene un campo extra', { ...VALID_BODY, extra: 'no' }],
    ['body no es string', { ...VALID_BODY, body: 123 }],
    ['body vacío tras trim', { ...VALID_BODY, body: '   ' }],
    ['body supera 180 caracteres', { ...VALID_BODY, body: 'a'.repeat(181) }],
    ['clientRequestId no es string', { ...VALID_BODY, clientRequestId: 123 }],
    ['clientRequestId no es un UUID válido', { ...VALID_BODY, clientRequestId: 'no-es-un-uuid' }],
  ])(
    'un payload inválido (%s) no llama al store y responde 400 VALIDATION_ERROR',
    async (_case, body) => {
      mockAuthenticated();
      const create = vi.fn();
      const app = buildTestApp(buildStore({ create }));

      const response = await request(app)
        .post(`/rooms/${ROOM_ID}/comments`)
        .set('Authorization', 'Bearer good-token')
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('una sala inexistente responde 404 NOT_FOUND', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ create: async () => null }));

    const response = await request(app)
      .post(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token')
      .send(VALID_BODY);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('un fallo no controlado del store responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      buildStore({
        create: async () => {
          throw new Error('detalle interno de base de datos');
        },
      }),
    );

    const response = await request(app)
      .post(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token')
      .send(VALID_BODY);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });

  it('un JSON malformado responde 400 VALIDATION_ERROR, no 500', async () => {
    mockAuthenticated();
    const create = vi.fn();
    const app = buildTestApp(buildStore({ create }));

    const response = await request(app)
      .post(`/rooms/${ROOM_ID}/comments`)
      .set('Authorization', 'Bearer good-token')
      .set('Content-Type', 'application/json')
      .send('{ esto no es JSON válido');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    });
    expect(create).not.toHaveBeenCalled();
  });
});
