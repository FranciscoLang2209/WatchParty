import { describe, expect, it, vi } from 'vitest';
import { CLOCK_SKEW_RETRY_DELAY_MS, retryOnClockSkew } from './retry-on-clock-skew.js';

const URL_MATCHES = 'https://example.supabase.co/rest/v1/matches?select=*';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const clockSkew = () => json(401, { code: 'PGRST303', message: 'JWT issued at future' });

function setup(...responses: Response[]) {
  const baseFetch = vi.fn<typeof fetch>();
  for (const response of responses) baseFetch.mockResolvedValueOnce(response);
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

  return { baseFetch, sleep, fetch: retryOnClockSkew(baseFetch, { sleep }) };
}

describe('retryOnClockSkew', () => {
  it('devuelve una respuesta exitosa sin reintentar', async () => {
    const ok = json(200, [{ id: 'm1' }]);
    const { baseFetch, sleep, fetch } = setup(ok);

    const response = await fetch(URL_MATCHES);

    expect(response).toBe(ok);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('ante PGRST303 espera y reintenta una vez', async () => {
    const ok = json(200, [{ id: 'm1' }]);
    const { baseFetch, sleep, fetch } = setup(clockSkew(), ok);

    const response = await fetch(URL_MATCHES);

    expect(response).toBe(ok);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(CLOCK_SKEW_RETRY_DELAY_MS);
  });

  it('reintenta con la misma URL, método y cuerpo', async () => {
    const { baseFetch, fetch } = setup(clockSkew(), json(200, {}));
    const init: RequestInit = { method: 'POST', body: '{"p_provider":"x"}' };

    await fetch(URL_MATCHES, init);

    expect(baseFetch).toHaveBeenNthCalledWith(1, URL_MATCHES, init);
    expect(baseFetch).toHaveBeenNthCalledWith(2, URL_MATCHES, init);
  });

  it('reintenta una sola vez: si vuelve a fallar, devuelve ese error', async () => {
    const { baseFetch, fetch } = setup(clockSkew(), clockSkew(), json(200, {}));

    const response = await fetch(URL_MATCHES);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'PGRST303' });
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('no reintenta otros 401 y deja el cuerpo legible', async () => {
    const { baseFetch, sleep, fetch } = setup(
      json(401, { code: 'PGRST301', message: 'JWT expired' }),
    );

    const response = await fetch(URL_MATCHES);

    expect(await response.json()).toMatchObject({ code: 'PGRST301' });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('no reintenta un 401 cuyo cuerpo no es JSON', async () => {
    const { baseFetch, fetch } = setup(new Response('Unauthorized', { status: 401 }));

    const response = await fetch(URL_MATCHES);

    expect(await response.text()).toBe('Unauthorized');
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('no reintenta errores de otro status con el mismo código', async () => {
    const { baseFetch, fetch } = setup(json(500, { code: 'PGRST303' }));

    await fetch(URL_MATCHES);

    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});
