import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoomsRouter } from './rooms-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { PublicRoom } from '../domain/public-room.js';
import type { PublicRoomStore } from '../domain/public-room-store.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValue({
    data: { user: { id: 'user-123', email: 'persona@example.com' } },
    error: null,
  } as GetUserResult);
}

const MATCH_ID = 'a1111111-1111-1111-1111-111111111111';
const UNKNOWN_ID = 'b2222222-2222-2222-2222-222222222222';

/**
 * Doble en memoria con el mismo contrato que `SupabasePublicRoomStore`: una
 * sala por partido, creada en el primer pedido. Solo conoce `MATCH_ID`.
 */
function makeStore(): PublicRoomStore & { rooms: PublicRoom[] } {
  const rooms: PublicRoom[] = [];

  return {
    rooms,
    getOrCreatePublicRoom: vi.fn(async (matchId: string) => {
      if (matchId !== MATCH_ID) return null;

      const existing = rooms.find((room) => room.matchId === matchId);
      if (existing) return existing;

      const room: PublicRoom = {
        id: 'd4444444-4444-4444-4444-444444444444',
        matchId,
        createdAt: '2026-09-17T12:00:00.000Z',
      };
      rooms.push(room);
      return room;
    }),
    findPublicRoomById: vi.fn(
      async (roomId: string) => rooms.find((room) => room.id === roomId) ?? null,
    ),
  };
}

function buildTestApp(store: PublicRoomStore) {
  const app = express();

  app.use(express.json());
  app.use(createRoomsRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: expect.any(String) } };
const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: expect.any(String) } };

describe('POST /matches/:matchId/room', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido responde 200 con { room } y solo los campos del contrato', async () => {
    mockAuthenticated();
    const app = buildTestApp(makeStore());

    const response = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      room: {
        id: 'd4444444-4444-4444-4444-444444444444',
        matchId: MATCH_ID,
        createdAt: '2026-09-17T12:00:00.000Z',
      },
    });
  });

  it('dos POST para el mismo partido devuelven la misma sala', async () => {
    mockAuthenticated();
    const store = makeStore();
    const app = buildTestApp(store);

    const first = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer good-token');
    const second = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer good-token');

    expect(second.body.room.id).toBe(first.body.room.id);
    expect(store.rooms).toHaveLength(1);
  });

  it('ignora un userId enviado en el cuerpo', async () => {
    mockAuthenticated();
    const store = makeStore();
    const app = buildTestApp(store);

    const response = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer good-token')
      .send({ userId: 'otra-persona' });

    expect(response.status).toBe(200);
    expect(store.getOrCreatePublicRoom).toHaveBeenCalledWith(MATCH_ID);
  });

  it('sin bearer responde 401 sin consultar el store', async () => {
    const store = makeStore();
    const app = buildTestApp(store);

    const response = await request(app).post(`/matches/${MATCH_ID}/room`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHORIZED_BODY);
    expect(store.getOrCreatePublicRoom).not.toHaveBeenCalled();
  });

  it('con un token inválido responde 401 sin consultar el store', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);
    const store = makeStore();
    const app = buildTestApp(store);

    const response = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHORIZED_BODY);
    expect(store.getOrCreatePublicRoom).not.toHaveBeenCalled();
  });

  it('un partido inexistente responde 404 con el envelope normal', async () => {
    mockAuthenticated();
    const app = buildTestApp(makeStore());

    const response = await request(app)
      .post(`/matches/${UNKNOWN_ID}/room`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND_BODY);
  });

  it('un matchId que no es UUID responde 404 sin consultar el store', async () => {
    mockAuthenticated();
    const store = makeStore();
    const app = buildTestApp(store);

    const response = await request(app)
      .post('/matches/no-es-un-uuid/room')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND_BODY);
    expect(store.getOrCreatePublicRoom).not.toHaveBeenCalled();
  });

  it('un fallo del store responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const store: PublicRoomStore = {
      getOrCreatePublicRoom: async () => {
        throw new Error('detalle interno de base de datos');
      },
      findPublicRoomById: vi.fn(),
    };
    const app = buildTestApp(store);

    const response = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });
});

describe('GET /rooms/:roomId', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('vuelve a cargar por id la sala creada con POST y responde 200 con { room }', async () => {
    mockAuthenticated();
    const app = buildTestApp(makeStore());

    const created = await request(app)
      .post(`/matches/${MATCH_ID}/room`)
      .set('Authorization', 'Bearer good-token');
    const response = await request(app)
      .get(`/rooms/${created.body.room.id}`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ room: created.body.room });
  });

  it('sin bearer responde 401 sin consultar el store', async () => {
    const store = makeStore();
    const app = buildTestApp(store);

    const response = await request(app).get(`/rooms/${UNKNOWN_ID}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHORIZED_BODY);
    expect(store.findPublicRoomById).not.toHaveBeenCalled();
  });

  it('una sala inexistente responde 404 con el envelope normal', async () => {
    mockAuthenticated();
    const app = buildTestApp(makeStore());

    const response = await request(app)
      .get(`/rooms/${UNKNOWN_ID}`)
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND_BODY);
  });

  it('un roomId que no es UUID responde 404 sin consultar el store', async () => {
    mockAuthenticated();
    const store = makeStore();
    const app = buildTestApp(store);

    const response = await request(app)
      .get('/rooms/no-es-un-uuid')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND_BODY);
    expect(store.findPublicRoomById).not.toHaveBeenCalled();
  });
});
