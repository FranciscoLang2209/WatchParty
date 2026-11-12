import { describe, it, expect, vi } from 'vitest';
import { createApiFootballClient } from './api-football-client.js';

const BASE_URL = 'https://v3.football.api-sports.io';
const API_KEY = 'test-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-ratelimit-requests-remaining': '90' },
  });
}

function build(fetchFn: typeof fetch) {
  return createApiFootballClient({ fetchFn, baseUrl: BASE_URL, apiKey: API_KEY });
}

describe('createApiFootballClient — pedidos de enriquecimiento', () => {
  it.each([
    ['fetchFixtureById', '/fixtures', 'id'],
    ['fetchFixtureStatistics', '/fixtures/statistics', 'fixture'],
    ['fetchFixtureEvents', '/fixtures/events', 'fixture'],
  ] as const)(
    '%s consulta %s con ?%s=<id> y la clave sólo en el header',
    async (method, path, param) => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ errors: [], response: [] }));

      const outcome = await build(fetchFn)[method]({ fixtureId: 1145512 });

      const [url, init] = fetchFn.mock.calls[0]!;
      const requestUrl = new URL(url as string | URL);

      expect(requestUrl.pathname).toBe(path);
      expect(requestUrl.searchParams.get(param)).toBe('1145512');
      expect(requestUrl.search).not.toContain(API_KEY);
      expect((init as RequestInit).headers).toMatchObject({ 'x-apisports-key': API_KEY });
      expect(outcome).toMatchObject({
        kind: 'response',
        status: 200,
        headers: { 'x-ratelimit-requests-remaining': '90' },
      });
    },
  );

  it('un fallo de red se devuelve tipado, sin lanzar y sin exponer la clave', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const outcome = await build(fetchFn).fetchFixtureEvents({ fixtureId: 1 });

    expect(outcome).toEqual({ kind: 'network-error', message: 'ECONNRESET' });
  });

  it('un timeout se devuelve como timeout', async () => {
    const fetchFn = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('abortado')));
        }),
    );
    const client = createApiFootballClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 5,
    });

    expect(await client.fetchFixtureStatistics({ fixtureId: 1 })).toEqual({ kind: 'timeout' });
  });
});
