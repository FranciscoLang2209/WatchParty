import { describe, it, expect, vi } from 'vitest';
import { probeAuthGuard, probeHealth } from './api-probes.js';

const BASE = 'https://api.example.test';

/** Reloj monotónico controlable: solo avanza cuando el test lo avanza. */
function fakeClock() {
  let nowMs = 1_000;

  return {
    monotonicMs: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function fakeResponse(status: number, readBody: () => Promise<string>): Response {
  return { status, text: readBody } as unknown as Response;
}

function namedError(name: string) {
  return Object.assign(new Error('fallo'), { name });
}

describe('probeHealth', () => {
  it('hace GET /health sin credenciales', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => fakeResponse(200, async () => '{}'));

    await probeHealth(BASE, { fetchFn, monotonicMs: clock.monotonicMs });

    const [url, init] = fetchFn.mock.calls[0]!;
    const headers = new Headers(init?.headers);

    expect(url).toBe(`${BASE}/health`);
    expect(init?.method).toBe('GET');
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Cookie')).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('mide la latencia con el reloj monotónico hasta leer el cuerpo completo', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      clock.advance(120); // headers
      return fakeResponse(200, async () => {
        clock.advance(30); // cuerpo
        return '{"status":"ok"}';
      });
    });

    const outcome = await probeHealth(BASE, { fetchFn, monotonicMs: clock.monotonicMs });

    expect(outcome).toEqual({ kind: 'response', status: 200, latencyMs: 150 });
  });

  it('informa el estado recibido aunque no sea 200', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => fakeResponse(503, async () => ''));

    await expect(
      probeHealth(BASE, { fetchFn, monotonicMs: clock.monotonicMs }),
    ).resolves.toMatchObject({ kind: 'response', status: 503 });
  });

  it.each([
    ['TimeoutError', 'timeout'],
    ['AbortError', 'timeout'],
    ['TypeError', 'network-error'],
  ])('un fallo %s sin respuesta es %s', async (name, reason) => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw namedError(name);
    });

    await expect(probeHealth(BASE, { fetchFn, monotonicMs: clock.monotonicMs })).resolves.toEqual({
      kind: 'failed',
      reason,
    });
  });

  it('si el cuerpo no se puede leer hasta el final no hay respuesta completa', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () =>
      fakeResponse(200, async () => {
        throw namedError('TypeError');
      }),
    );

    await expect(probeHealth(BASE, { fetchFn, monotonicMs: clock.monotonicMs })).resolves.toEqual({
      kind: 'failed',
      reason: 'network-error',
    });
  });

  it('respeta el timeout configurado', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    await expect(
      probeHealth(BASE, { fetchFn, monotonicMs: clock.monotonicMs, timeoutMs: 20 }),
    ).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
  });
});

describe('probeAuthGuard', () => {
  it('hace GET /matches SIN token', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => fakeResponse(401, async () => '{}'));

    const outcome = await probeAuthGuard(BASE, { fetchFn, monotonicMs: clock.monotonicMs });

    const [url, init] = fetchFn.mock.calls[0]!;
    const headers = new Headers(init?.headers);

    expect(url).toBe(`${BASE}/matches`);
    expect(init?.method).toBe('GET');
    expect(headers.get('Authorization')).toBeNull();
    expect(outcome).toMatchObject({ kind: 'response', status: 401 });
  });

  it('una caída de red no es una respuesta', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw namedError('TypeError');
    });

    await expect(
      probeAuthGuard(BASE, { fetchFn, monotonicMs: clock.monotonicMs }),
    ).resolves.toEqual({ kind: 'failed', reason: 'network-error' });
  });
});
