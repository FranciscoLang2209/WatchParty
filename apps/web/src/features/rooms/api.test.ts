import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterRoom, getRoom } from './api';
import { RoomsApiError, isCancelled, isUnauthorized } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const MATCH_ID = 'a1111111-1111-1111-1111-111111111111';
const ROOM_ID = 'b2222222-2222-4222-8222-222222222222';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const sala = { id: ROOM_ID, matchId: MATCH_ID, createdAt: '2026-09-17T12:00:00Z' };

const fetchMock = vi.fn();

function respondWith(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;

  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function requestUrl(): string {
  return fetchMock.mock.calls[0]![0] as string;
}

function requestInit(): RequestInit {
  return fetchMock.mock.calls[0]![1] as RequestInit;
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.mockReturnValue({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enterRoom', () => {
  it('manda POST /matches/:matchId/room con bearer', async () => {
    respondWith({ room: sala }, { status: 201 });

    await enterRoom(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/room`);
    expect(requestInit().method).toBe('POST');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('no manda cuerpo: el servidor no recibe userId del cliente', async () => {
    respondWith({ room: sala }, { status: 201 });

    await enterRoom(MATCH_ID, TOKEN);

    expect(requestInit().body).toBeUndefined();
  });

  it('arma la URL sin barra doble aunque la base termine en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}///`,
    });
    respondWith({ room: sala }, { status: 201 });

    await enterRoom(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/room`);
  });

  it('codifica el matchId sin interpretarlo', async () => {
    respondWith({ room: sala }, { status: 201 });

    await enterRoom('id con/barra', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/id%20con%2Fbarra/room`);
  });

  it('devuelve la sala recién creada (201)', async () => {
    respondWith({ room: sala }, { status: 201 });

    await expect(enterRoom(MATCH_ID, TOKEN)).resolves.toEqual(sala);
  });

  it('devuelve la sala que ya existía (200)', async () => {
    respondWith({ room: sala }, { status: 200 });

    await expect(enterRoom(MATCH_ID, TOKEN)).resolves.toEqual(sala);
  });

  it('traduce un partido inexistente a no encontrado', async () => {
    respondWith({ error: { code: 'NOT_FOUND' } }, { status: 404 });

    await expect(enterRoom(MATCH_ID, TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('getRoom', () => {
  it('consulta GET /rooms/:roomId con bearer', async () => {
    respondWith({ room: sala });

    await getRoom(ROOM_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('arma la URL sin barra doble aunque la base termine en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}/`,
    });
    respondWith({ room: sala });

    await getRoom(ROOM_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}`);
  });

  it('devuelve los tres campos de la sala', async () => {
    respondWith({ room: sala });

    await expect(getRoom(ROOM_ID, TOKEN)).resolves.toEqual(sala);
  });

  it('descarta los campos que no son parte de PublicRoom', async () => {
    respondWith({ room: { ...sala, ownerId: 'user-1', members: [] } });

    const resultado = await getRoom(ROOM_ID, TOKEN);

    expect(Object.keys(resultado).sort()).toEqual(['createdAt', 'id', 'matchId']);
  });

  it('traduce una sala inexistente a no encontrado', async () => {
    respondWith({ error: { code: 'NOT_FOUND' } }, { status: 404 });

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('la validación del envelope', () => {
  it('rechaza un cuerpo que no es un objeto', async () => {
    respondWith(null);

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un envelope sin la clave room', async () => {
    respondWith({ sala });

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza room null', async () => {
    respondWith({ room: null }, { status: 201 });

    await expect(enterRoom(MATCH_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza una sala sin matchId', async () => {
    respondWith({ room: { id: ROOM_ID, createdAt: sala.createdAt } });

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza una sala con campos del tipo equivocado', async () => {
    respondWith({ room: { ...sala, createdAt: 1726574400000 } });

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un cuerpo exitoso que no es JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('el mapeo de errores', () => {
  it('traduce 401 a sesión vencida', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });

    await expect(enterRoom(MATCH_ID, TOKEN)).rejects.toSatisfy(isUnauthorized);
  });

  it('traduce 403 a sesión vencida', async () => {
    respondWith({}, { status: 403 });

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('traduce 500 a error del servidor', async () => {
    respondWith({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });

    await expect(enterRoom(MATCH_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('cae al status HTTP cuando el cuerpo no es el contrato de errores', async () => {
    // Un proxy devolviendo HTML no puede tumbar el mapeo.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('prefiere el código del contrato por sobre el status', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, { status: 500 });

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('traduce un fallo de red', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(enterRoom(MATCH_ID, TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });

  it('distingue el abort de un fallo de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    await expect(getRoom(ROOM_ID, TOKEN)).rejects.toSatisfy(isCancelled);
  });

  it('propaga la señal de abort al fetch', async () => {
    const controller = new AbortController();
    respondWith({ room: sala });

    await getRoom(ROOM_ID, TOKEN, controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });

  it('no muestra el motivo interno: cada mensaje es presentable', async () => {
    respondWith(
      { error: { code: 'INTERNAL_ERROR', detail: 'pg: relation "rooms" missing' } },
      { status: 500 },
    );

    const error = await getRoom(ROOM_ID, TOKEN).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RoomsApiError);
    expect((error as RoomsApiError).message).not.toContain('pg:');
    expect((error as RoomsApiError).message).not.toContain('relation');
  });
});
