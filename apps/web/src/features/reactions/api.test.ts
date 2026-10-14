import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReaction, setReaction } from './api';
import { ReactionsApiError, isCancelled } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const ROOM_ID = 'a1111111-1111-1111-1111-111111111111';
const COMMENT_ID = 'b2222222-2222-2222-2222-222222222222';
const REACTION_URL = `${API_BASE}/rooms/${ROOM_ID}/comments/${COMMENT_ID}/reaction`;

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const fetchMock = vi.fn();

function respondWith(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
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

async function failureOf(promise: Promise<unknown>): Promise<ReactionsApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ReactionsApiError;
  }
  throw new Error('Debería haber fallado.');
}

// Las tres operaciones comparten contrato: se prueban con las mismas reglas.
const OPERATIONS = [
  ['getReaction', 'GET', (signal?: AbortSignal) => getReaction(ROOM_ID, COMMENT_ID, TOKEN, signal)],
  [
    'setReaction(true)',
    'PUT',
    (signal?: AbortSignal) => setReaction(ROOM_ID, COMMENT_ID, true, TOKEN, signal),
  ],
  [
    'setReaction(false)',
    'DELETE',
    (signal?: AbortSignal) => setReaction(ROOM_ID, COMMENT_ID, false, TOKEN, signal),
  ],
] as const;

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

describe.each(OPERATIONS)('%s', (_name, method, run) => {
  it(`manda ${method} a la ruta real de la reacción, con bearer y sin cuerpo`, async () => {
    respondWith({ reaction: { count: 3, reacted: true } });

    await run();

    expect(requestUrl()).toBe(REACTION_URL);
    expect(requestInit().method).toBe(method);
    expect(requestInit().body).toBeUndefined();

    const headers = new Headers(requestInit().headers);

    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Accept')).toBe('application/json');
    // La persona sale del bearer: ningún otro dato de identidad viaja.
    expect([...headers.keys()].sort()).toEqual(['accept', 'authorization']);
  });

  it('arma la URL sin barra doble aunque la base termine en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}///`,
    });
    respondWith({ reaction: { count: 0, reacted: false } });

    await run();

    expect(requestUrl()).toBe(REACTION_URL);
  });

  it('devuelve solo count y reacted, descartando cualquier campo extra', async () => {
    respondWith({
      reaction: { count: 2, reacted: false, userId: 'u-1', commentId: COMMENT_ID },
      requestId: 'r-1',
    });

    await expect(run()).resolves.toEqual({ count: 2, reacted: false });
  });

  it('cero es un conteo válido cuando el servidor lo informó', async () => {
    respondWith({ reaction: { count: 0, reacted: false } });

    await expect(run()).resolves.toEqual({ count: 0, reacted: false });
  });

  it.each([
    ['sin reaction', {}],
    ['body null', null],
    ['body que no es objeto', 'ok'],
    ['reaction null', { reaction: null }],
    ['reaction que no es objeto', { reaction: 5 }],
    ['count ausente', { reaction: { reacted: true } }],
    ['count null', { reaction: { count: null, reacted: true } }],
    ['count como texto', { reaction: { count: '3', reacted: true } }],
    ['count negativo', { reaction: { count: -1, reacted: true } }],
    ['count decimal', { reaction: { count: 1.5, reacted: true } }],
    ['count fuera del rango seguro', { reaction: { count: 2 ** 53, reacted: true } }],
    ['reacted ausente', { reaction: { count: 1 } }],
    ['reacted null', { reaction: { count: 1, reacted: null } }],
    ['reacted como texto', { reaction: { count: 1, reacted: 'true' } }],
    ['reacted como número', { reaction: { count: 1, reacted: 1 } }],
    ['campos sin envolver en reaction', { count: 1, reacted: true }],
  ])('rechaza una respuesta inválida: %s', async (_label, body) => {
    respondWith(body);

    const error = await failureOf(run());

    expect(error).toBeInstanceOf(ReactionsApiError);
    expect(error.kind).toBe('server');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rechaza un count %s', async (_label, count) => {
    // JSON no puede transportar estos valores: se simula un `json()` ya parseado.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reaction: { count, reacted: true } }),
    } as unknown as Response);

    expect((await failureOf(run())).kind).toBe('server');
  });

  it('un JSON ilegible en una respuesta exitosa es un error de servidor', async () => {
    fetchMock.mockResolvedValue(new Response('<html>no es json</html>', { status: 200 }));

    expect((await failureOf(run())).kind).toBe('server');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [400, 'server'],
    [500, 'server'],
  ])('un %i se traduce a %s', async (status, kind) => {
    respondWith({}, status);

    const error = await failureOf(run());

    expect(error).toBeInstanceOf(ReactionsApiError);
    expect(error.kind).toBe(kind);
  });

  it('prefiere el código del contrato de errores de la API al status HTTP', async () => {
    respondWith({ error: { code: 'NOT_FOUND', message: 'x' } }, 500);

    expect((await failureOf(run())).kind).toBe('not-found');
  });

  it('un error con cuerpo que no es JSON (p. ej. un proxy) se resuelve por status', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 404 }));

    expect((await failureOf(run())).kind).toBe('not-found');
  });

  it('los mensajes presentables no exponen detalle del servidor', async () => {
    respondWith({ error: { code: 'INTERNAL_ERROR', message: 'relation "x" does not exist' } }, 500);

    const error = await failureOf(run());

    expect(error.message).toBe('No pudimos actualizar la reacción. Intentá de nuevo.');
  });

  it('una caída de red se traduce a network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect((await failureOf(run())).kind).toBe('network');
  });

  it('una operación abortada es cancelled y no se anuncia', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await failureOf(run());

    expect(error.kind).toBe('cancelled');
    expect(isCancelled(error)).toBe(true);
  });

  it('abortar mientras se lee el cuerpo también es cancelled', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw abortError();
      },
    } as unknown as Response);

    expect(isCancelled(await failureOf(run()))).toBe(true);
  });

  it('pasa la señal de cancelación a fetch', async () => {
    respondWith({ reaction: { count: 1, reacted: true } });
    const controller = new AbortController();

    await run(controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });
});

describe('setReaction', () => {
  it('devuelve el estado que confirma el servidor, no el que se pidió', async () => {
    respondWith({ reaction: { count: 4, reacted: false } });

    await expect(setReaction(ROOM_ID, COMMENT_ID, true, TOKEN)).resolves.toEqual({
      count: 4,
      reacted: false,
    });
  });
});

describe('ids opacos', () => {
  it('se codifican sin interpretarlos', async () => {
    respondWith({ reaction: { count: 0, reacted: false } });

    await getReaction('sala/rara 1', 'comentario?x=1#y', TOKEN);

    expect(requestUrl()).toBe(
      `${API_BASE}/rooms/sala%2Frara%201/comments/comentario%3Fx%3D1%23y/reaction`,
    );
  });
});

describe('isCancelled', () => {
  it('solo reconoce los errores cancelados de este cliente', () => {
    expect(isCancelled(new ReactionsApiError('cancelled', 'x'))).toBe(true);
    expect(isCancelled(new ReactionsApiError('network', 'x'))).toBe(false);
    expect(isCancelled(new Error('cancelled'))).toBe(false);
    expect(isCancelled(undefined)).toBe(false);
  });
});
