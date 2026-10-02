import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFootballDataOrgClient } from './football-data-org-client.js';

const BASE_URL = 'https://api.football-data.org';
const API_KEY = 'test-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createFootballDataOrgClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consulta la competición con el header de autenticación inyectado', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }));
    const client = createFootballDataOrgClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    await client.fetchMatches({ competitionCode: 'PL' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    const requestUrl = new URL(url as string | URL);

    expect(requestUrl.pathname).toBe('/v4/competitions/PL/matches');
    expect(requestUrl.searchParams.has('status')).toBe(false);
    expect((init as RequestInit).headers).toMatchObject({ 'X-Auth-Token': API_KEY });
  });

  it('incluye el filtro status cuando se pide', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }));
    const client = createFootballDataOrgClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    await client.fetchMatches({ competitionCode: 'PL', status: 'SCHEDULED' });

    const [url] = fetchFn.mock.calls[0]!;
    const requestUrl = new URL(url as string | URL);
    expect(requestUrl.searchParams.get('status')).toBe('SCHEDULED');
  });

  it('devuelve el status y el body en una respuesta exitosa', async () => {
    const body = { matches: [{}] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = createFootballDataOrgClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    const outcome = await client.fetchMatches({ competitionCode: 'PL' });

    expect(outcome).toMatchObject({ kind: 'response', status: 200, ok: true, body });
    expect((outcome as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/json',
    );
  });

  it('devuelve network-error cuando fetch rechaza por un motivo distinto a timeout', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('connection refused'));
    const client = createFootballDataOrgClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });

    const outcome = await client.fetchMatches({ competitionCode: 'PL' });

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
    const client = createFootballDataOrgClient({
      fetchFn,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 1_000,
    });

    const outcomePromise = client.fetchMatches({ competitionCode: 'PL' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcomePromise).toEqual({ kind: 'timeout' });
  });
});
