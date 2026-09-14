import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiFootballClient } from './api-football-client.js';

const BASE_URL = 'https://v3.football.api-sports.io';
const API_KEY = 'test-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createApiFootballClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consulta la página con los parámetros aprobados y la clave inyectada', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ errors: [], results: 0, paging: { current: 1, total: 1 }, response: [] }),
      );
    const client = createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    await client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    const requestUrl = new URL(url as string | URL);

    expect(requestUrl.pathname).toBe('/fixtures');
    expect(requestUrl.searchParams.get('league')).toBe('128');
    expect(requestUrl.searchParams.get('season')).toBe('2023');
    expect(requestUrl.searchParams.get('from')).toBe('2023-03-01');
    expect(requestUrl.searchParams.get('to')).toBe('2023-03-14');
    expect(requestUrl.searchParams.has('page')).toBe(false);
    expect((init as RequestInit).headers).toMatchObject({ 'x-apisports-key': API_KEY });
  });

  it('sí incluye el parámetro page cuando es mayor a 1', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ errors: [], results: 0, paging: { current: 2, total: 2 }, response: [] }),
      );
    const client = createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    await client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 2,
    });

    const [url] = fetchFn.mock.calls[0]!;
    const requestUrl = new URL(url as string | URL);
    expect(requestUrl.searchParams.get('page')).toBe('2');
  });

  it('devuelve el status y el body en una respuesta exitosa', async () => {
    const body = { errors: [], results: 1, paging: { current: 1, total: 1 }, response: [{}] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    const outcome = await client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    expect(outcome).toMatchObject({
      kind: 'response',
      status: 200,
      ok: true,
      body,
      paging: body.paging,
    });
    expect((outcome as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/json',
    );
  });

  it('no reintenta ni consulta páginas adicionales por su cuenta', async () => {
    const body = { errors: [], results: 50, paging: { current: 1, total: 5 }, response: [] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    await client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('expone los headers crudos de la respuesta sin interpretarlos', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [],
          results: 0,
          paging: { current: 1, total: 1 },
          response: [],
        }),
        { status: 429, headers: { 'Retry-After': '5', 'x-ratelimit-requests-remaining': '10' } },
      ),
    );
    const client = createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    const outcome = await client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    expect(outcome).toMatchObject({
      kind: 'response',
      status: 429,
      headers: {
        'retry-after': '5',
        'x-ratelimit-requests-remaining': '10',
      },
    });
  });

  it('devuelve network-error cuando fetch rechaza por un motivo distinto a timeout', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('connection refused'));
    const client = createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    const outcome = await client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    expect(outcome).toEqual({ kind: 'network-error', message: 'connection refused' });
  });

  it('devuelve timeout cuando la respuesta tarda más que el límite configurado', async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = createApiFootballClient({
      fetchFn,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 1000,
    });

    const pending = client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ kind: 'timeout' });
  });

  it('un timeout mientras se lee el body se reporta como timeout, no como cuerpo inválido', async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      } as unknown as Response),
    );
    const client = createApiFootballClient({
      fetchFn,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 1000,
    });

    const pending = client.fetchFixturesPage({
      league: 128,
      season: 2023,
      from: '2023-03-01',
      to: '2023-03-14',
      page: 1,
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ kind: 'timeout' });
  });
});
