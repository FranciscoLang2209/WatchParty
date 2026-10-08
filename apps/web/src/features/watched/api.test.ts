import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWatched } from './api';
import { WatchedApiError, isCancelled } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

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

async function failureOf(promise: Promise<unknown>): Promise<WatchedApiError> {
  try {
    await promise;
  } catch (error) {
    return error as WatchedApiError;
  }
  throw new Error('Debería haber fallado.');
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

describe('setWatched', () => {
  it('manda PUT /matches/:matchId/watched con bearer para marcar', async () => {
    respondWith({ watched: true });

    await setWatched(MATCH_ID, true, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/watched`);
    expect(requestInit().method).toBe('PUT');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('manda DELETE para deshacer', async () => {
    respondWith({ watched: false });

    await setWatched(MATCH_ID, false, TOKEN);

    expect(requestInit().method).toBe('DELETE');
  });

  it('no manda cuerpo: el servidor no recibe userId del cliente', async () => {
    respondWith({ watched: true });

    await setWatched(MATCH_ID, true, TOKEN);

    expect(requestInit().body).toBeUndefined();
  });

  it('arma la URL sin barra doble aunque la base termine en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}///`,
    });
    respondWith({ watched: true });

    await setWatched(MATCH_ID, true, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/watched`);
  });

  it('codifica el matchId sin interpretarlo', async () => {
    respondWith({ watched: true });

    await setWatched('id opaco/raro', true, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/id%20opaco%2Fraro/watched`);
  });

  it('devuelve el estado que confirma el servidor, no el que se pidió', async () => {
    respondWith({ watched: false });

    await expect(setWatched(MATCH_ID, true, TOKEN)).resolves.toBe(false);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [400, 'server'],
    [500, 'server'],
  ])('un %i se traduce a %s', async (status, kind) => {
    respondWith({}, { status });

    const error = await failureOf(setWatched(MATCH_ID, true, TOKEN));

    expect(error).toBeInstanceOf(WatchedApiError);
    expect(error.kind).toBe(kind);
  });

  it('prefiere el código del contrato de errores de la API al status HTTP', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED', message: 'x' } }, { status: 500 });

    const error = await failureOf(setWatched(MATCH_ID, true, TOKEN));

    expect(error.kind).toBe('unauthorized');
  });

  it('un cuerpo sin watched booleano es un error de servidor', async () => {
    respondWith({ watched: 'si' });

    const error = await failureOf(setWatched(MATCH_ID, true, TOKEN));

    expect(error.kind).toBe('server');
  });

  it('un JSON ilegible en una respuesta exitosa es un error de servidor', async () => {
    // Cuerpo que no es JSON: `response.json()` lanza un SyntaxError real.
    fetchMock.mockResolvedValue(new Response('<html>no es json</html>', { status: 200 }));

    const error = await failureOf(setWatched(MATCH_ID, true, TOKEN));

    expect(error.kind).toBe('server');
  });

  it('una caída de red se traduce a network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await failureOf(setWatched(MATCH_ID, true, TOKEN));

    expect(error.kind).toBe('network');
  });

  it('una operación abortada es cancelled y no se anuncia', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await failureOf(setWatched(MATCH_ID, true, TOKEN));

    expect(isCancelled(error)).toBe(true);
  });
});
