import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHED_HISTORY_PAGE_SIZE, getWatched, listWatchedHistoryPage, setWatched } from './api';
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

describe('getWatched', () => {
  it('manda GET /matches/:matchId/watched con bearer y sin cuerpo', async () => {
    respondWith({ watched: true });

    await getWatched(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/watched`);
    expect(requestInit().method).toBe('GET');
    expect(requestInit().body).toBeUndefined();
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([true, false])('devuelve el estado persistido: %s', async (watched) => {
    respondWith({ watched });

    await expect(getWatched(MATCH_ID, TOKEN)).resolves.toBe(watched);
  });

  it('pasa la señal de cancelación al fetch', async () => {
    respondWith({ watched: true });
    const controller = new AbortController();

    await getWatched(MATCH_ID, TOKEN, controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [500, 'server'],
  ])('un %i se traduce a %s, nunca a false', async (status, kind) => {
    respondWith({}, { status });

    const error = await failureOf(getWatched(MATCH_ID, TOKEN));

    expect(error).toBeInstanceOf(WatchedApiError);
    expect(error.kind).toBe(kind);
  });

  it('un cuerpo sin watched booleano es un error de servidor, no false', async () => {
    respondWith({});

    const error = await failureOf(getWatched(MATCH_ID, TOKEN));

    expect(error.kind).toBe('server');
  });

  it('una caída de red se traduce a network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await failureOf(getWatched(MATCH_ID, TOKEN));

    expect(error.kind).toBe('network');
  });

  it('una lectura abortada es cancelled', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await failureOf(getWatched(MATCH_ID, TOKEN));

    expect(isCancelled(error)).toBe(true);
  });
});

describe('listWatchedHistoryPage', () => {
  const MATCH = {
    id: MATCH_ID,
    homeTeam: 'Boca',
    homeTeamId: 't1',
    awayTeam: 'River',
    awayTeamId: 't2',
    kickoffAt: '2026-10-10T21:00:00Z',
    status: 'finished',
  };
  const ITEM = { match: MATCH, watchedAt: '2026-10-11T12:00:00.000Z' };
  const CURSOR = { watchedAt: '2026-10-11T12:00:00.123456+00:00', matchId: MATCH_ID };

  it('manda GET /me/watched-matches con bearer, límite y sin cuerpo', async () => {
    respondWith({ items: [], nextCursor: null });

    await listWatchedHistoryPage(TOKEN);

    const url = new URL(requestUrl());
    expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE}/me/watched-matches`);
    expect(url.searchParams.get('limit')).toBe(String(WATCHED_HISTORY_PAGE_SIZE));
    expect(url.searchParams.has('beforeWatchedAt')).toBe(false);
    expect(url.searchParams.has('beforeMatchId')).toBe(false);
    expect(requestInit().method).toBe('GET');
    expect(requestInit().body).toBeUndefined();
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('manda el cursor tal cual, con el «+» del offset codificado', async () => {
    respondWith({ items: [], nextCursor: null });

    await listWatchedHistoryPage(TOKEN, { cursor: CURSOR });

    expect(requestUrl()).toContain('beforeWatchedAt=2026-10-11T12%3A00%3A00.123456%2B00%3A00');
    const url = new URL(requestUrl());
    expect(url.searchParams.get('beforeWatchedAt')).toBe(CURSOR.watchedAt);
    expect(url.searchParams.get('beforeMatchId')).toBe(CURSOR.matchId);
  });

  it('devuelve los ítems validados y el cursor siguiente, sin campos extra', async () => {
    respondWith({
      items: [{ ...ITEM, userId: 'otro', match: { ...MATCH, extra: 1 } }],
      nextCursor: { ...CURSOR, extra: true },
    });

    await expect(listWatchedHistoryPage(TOKEN)).resolves.toEqual({
      items: [ITEM],
      nextCursor: CURSOR,
    });
  });

  it.each([null, undefined])('un nextCursor %s es el fin de la lista', async (nextCursor) => {
    respondWith({ items: [ITEM], nextCursor });

    const page = await listWatchedHistoryPage(TOKEN);

    expect(page.nextCursor).toBeNull();
  });

  it('una lista vacía no es un error', async () => {
    respondWith({ items: [], nextCursor: null });

    await expect(listWatchedHistoryPage(TOKEN)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('pasa la señal de cancelación al fetch', async () => {
    respondWith({ items: [], nextCursor: null });
    const controller = new AbortController();

    await listWatchedHistoryPage(TOKEN, { signal: controller.signal });

    expect(requestInit().signal).toBe(controller.signal);
  });

  it.each([
    ['sin items', { nextCursor: null }],
    ['items que no es lista', { items: {}, nextCursor: null }],
    ['un partido inválido', { items: [{ ...ITEM, match: { ...MATCH, status: 'LIVE' } }] }],
    ['un ítem sin watchedAt', { items: [{ match: MATCH }] }],
    ['un cursor incompleto', { items: [], nextCursor: { watchedAt: CURSOR.watchedAt } }],
    ['un cursor que no es objeto', { items: [], nextCursor: 'abc' }],
  ])('un cuerpo con %s es un error de servidor', async (_caso, body) => {
    respondWith(body);

    const error = await failureOf(listWatchedHistoryPage(TOKEN));

    expect(error).toBeInstanceOf(WatchedApiError);
    expect(error.kind).toBe('server');
    expect(error.message).toBe('No pudimos cargar tu historial. Intentá de nuevo.');
  });

  it.each([
    [401, 'unauthorized'],
    [400, 'server'],
    [500, 'server'],
  ])('un %i se traduce a %s', async (status, kind) => {
    respondWith({}, { status });

    const error = await failureOf(listWatchedHistoryPage(TOKEN));

    expect(error.kind).toBe(kind);
  });

  it('una caída de red se traduce a network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await failureOf(listWatchedHistoryPage(TOKEN));

    expect(error.kind).toBe('network');
  });

  it('una consulta abortada es cancelled y no se anuncia', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await failureOf(listWatchedHistoryPage(TOKEN));

    expect(isCancelled(error)).toBe(true);
  });
});
