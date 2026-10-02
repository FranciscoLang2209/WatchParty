import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMENTS_PAGE_SIZE, listComments, listCommentsPage, postComment } from './api';
import { CommentsApiError, isCancelled, isUnauthorized } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const ROOM_ID = 'room-1';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const COMMENT = {
  id: 'comment-1',
  roomId: ROOM_ID,
  body: 'Qué golazo',
  createdAt: '2026-09-19T12:00:00.000Z',
};

const COMMENT_INPUT = {
  body: 'Qué golazo',
  clientRequestId: '11111111-1111-1111-1111-111111111111',
};

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

describe('listComments', () => {
  it('consulta GET /rooms/:roomId/comments con bearer', async () => {
    respondWith({ comments: [COMMENT] });

    await listComments(ROOM_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('arma la URL sin barra doble aunque la base termine en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}///`,
    });
    respondWith({ comments: [] });

    await listComments(ROOM_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments`);
  });

  it('codifica el roomId sin interpretarlo', async () => {
    respondWith({ comments: [] });

    await listComments('id con/barra', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/rooms/id%20con%2Fbarra/comments`);
  });

  it('devuelve los comentarios en el orden que manda el servidor', async () => {
    const segundo = { ...COMMENT, id: 'comment-2', createdAt: '2026-09-19T12:05:00.000Z' };
    respondWith({ comments: [COMMENT, segundo] });

    await expect(listComments(ROOM_ID, TOKEN)).resolves.toEqual([COMMENT, segundo]);
  });

  it('devuelve lista vacía si la sala no tiene comentarios', async () => {
    respondWith({ comments: [] });

    await expect(listComments(ROOM_ID, TOKEN)).resolves.toEqual([]);
  });

  it('descarta los campos que no son parte de RoomComment', async () => {
    respondWith({ comments: [{ ...COMMENT, authorId: 'user-1', clientRequestId: 'req-1' }] });

    const [resultado] = await listComments(ROOM_ID, TOKEN);

    expect(Object.keys(resultado!).sort()).toEqual(['body', 'createdAt', 'id', 'roomId'].sort());
  });

  it('traduce una sala inexistente a no encontrada', async () => {
    respondWith({ error: { code: 'NOT_FOUND' } }, { status: 404 });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('listCommentsPage', () => {
  // El cursor es opaco: el `createdAt` crudo de la base, con microsegundos y offset.
  const CURSOR = {
    createdAt: '2026-09-19T12:00:00.123456+00:00',
    id: 'c1111111-1111-4111-8111-111111111111',
  };

  it('pide la primera página con limit=20 y bearer, sin cursor', async () => {
    respondWith({ comments: [COMMENT], nextCursor: null });

    await listCommentsPage(ROOM_ID, TOKEN);

    expect(COMMENTS_PAGE_SIZE).toBe(20);
    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments?limit=20`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('con cursor manda beforeCreatedAt y beforeId juntos, codificados', async () => {
    respondWith({ comments: [], nextCursor: null });

    await listCommentsPage(ROOM_ID, TOKEN, { cursor: CURSOR });

    const url = new URL(requestUrl());

    expect(url.pathname).toBe(`/rooms/${ROOM_ID}/comments`);
    expect([...url.searchParams.keys()].sort()).toEqual(['beforeCreatedAt', 'beforeId', 'limit']);
    expect(url.searchParams.get('limit')).toBe('20');
    // El «+» del offset tiene que viajar codificado: sin codificar llega como espacio.
    expect(url.searchParams.get('beforeCreatedAt')).toBe(CURSOR.createdAt);
    expect(url.searchParams.get('beforeId')).toBe(CURSOR.id);
  });

  it('devuelve los comentarios y el cursor de la página siguiente', async () => {
    respondWith({ comments: [COMMENT], nextCursor: { ...CURSOR, extra: 'x' } });

    await expect(listCommentsPage(ROOM_ID, TOKEN)).resolves.toEqual({
      comments: [COMMENT],
      nextCursor: CURSOR,
    });
  });

  it.each([
    ['null', { comments: [COMMENT], nextCursor: null }],
    ['ausente', { comments: [COMMENT] }],
  ])('sin página siguiente (nextCursor %s) devuelve nextCursor null', async (_caso, body) => {
    respondWith(body);

    await expect(listCommentsPage(ROOM_ID, TOKEN)).resolves.toEqual({
      comments: [COMMENT],
      nextCursor: null,
    });
  });

  it('rechaza un nextCursor con forma inesperada', async () => {
    respondWith({ comments: [COMMENT], nextCursor: { createdAt: 5 } });

    await expect(listCommentsPage(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un envelope sin la clave comments', async () => {
    respondWith({ nextCursor: null });

    await expect(listCommentsPage(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('propaga la señal de abort al fetch', async () => {
    respondWith({ comments: [], nextCursor: null });
    const controller = new AbortController();

    await listCommentsPage(ROOM_ID, TOKEN, { signal: controller.signal });

    expect(requestInit().signal).toBe(controller.signal);
  });
});

describe('postComment', () => {
  it('manda POST con bearer y Content-Type JSON', async () => {
    respondWith({ comment: COMMENT }, { status: 201 });

    await postComment(ROOM_ID, COMMENT_INPUT, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments`);
    expect(requestInit().method).toBe('POST');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(requestInit().headers).get('Content-Type')).toBe('application/json');
  });

  it('manda exactamente body y clientRequestId: nada de authorId ni campos extra', async () => {
    respondWith({ comment: COMMENT }, { status: 201 });

    await postComment(ROOM_ID, COMMENT_INPUT, TOKEN);

    expect(JSON.parse(requestInit().body as string)).toEqual(COMMENT_INPUT);
  });

  it('devuelve el comentario recién creado (201)', async () => {
    respondWith({ comment: COMMENT }, { status: 201 });

    await expect(postComment(ROOM_ID, COMMENT_INPUT, TOKEN)).resolves.toEqual(COMMENT);
  });

  it('traduce una sala inexistente a no encontrada', async () => {
    respondWith({ error: { code: 'NOT_FOUND' } }, { status: 404 });

    await expect(postComment(ROOM_ID, COMMENT_INPUT, TOKEN)).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('traduce un comentario inválido (400) a invalid', async () => {
    respondWith({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });

    await expect(postComment(ROOM_ID, COMMENT_INPUT, TOKEN)).rejects.toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('la validación del envelope', () => {
  it('rechaza un cuerpo que no es un objeto', async () => {
    respondWith(null);

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un envelope sin la clave comments', async () => {
    respondWith({ items: [COMMENT] });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza comments que no es un array', async () => {
    respondWith({ comments: 'no es un array' });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un envelope sin la clave comment', async () => {
    respondWith({ sala: COMMENT }, { status: 201 });

    await expect(postComment(ROOM_ID, COMMENT_INPUT, TOKEN)).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('rechaza un comentario con campos del tipo equivocado', async () => {
    respondWith({ comments: [{ ...COMMENT, createdAt: 1758283200000 }] });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un cuerpo exitoso que no es JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('el mapeo de errores', () => {
  it('traduce 401 a sesión vencida', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toSatisfy(isUnauthorized);
  });

  it('traduce 403 a sesión vencida', async () => {
    respondWith({}, { status: 403 });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('traduce 500 a error del servidor', async () => {
    respondWith({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'server' });
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

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('prefiere el código del contrato por sobre el status', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, { status: 500 });

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('traduce un fallo de red', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(postComment(ROOM_ID, COMMENT_INPUT, TOKEN)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('distingue el abort de un fallo de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    await expect(listComments(ROOM_ID, TOKEN)).rejects.toSatisfy(isCancelled);
  });

  it('propaga la señal de abort al fetch', async () => {
    const controller = new AbortController();
    respondWith({ comments: [] });

    await listComments(ROOM_ID, TOKEN, controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });

  it('no muestra el motivo interno: cada mensaje es presentable', async () => {
    respondWith(
      { error: { code: 'INTERNAL_ERROR', detail: 'pg: relation "room_comments" missing' } },
      { status: 500 },
    );

    const error = await listComments(ROOM_ID, TOKEN).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommentsApiError);
    expect((error as CommentsApiError).message).not.toContain('pg:');
    expect((error as CommentsApiError).message).not.toContain('relation');
  });
});
