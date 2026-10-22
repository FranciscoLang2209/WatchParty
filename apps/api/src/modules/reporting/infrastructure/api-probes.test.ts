import { describe, it, expect, vi } from 'vitest';
import {
  hasExpectedMatchesSchema,
  probeAuthGuard,
  probeCatalogRead,
  probeHealth,
} from './api-probes.js';

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

describe('probeCatalogRead', () => {
  const TOKEN = 'SIMULATED.ACCESS.TOKEN';
  const MATCH = {
    id: 'm1',
    homeTeam: 'Everton FC',
    homeTeamId: 't1',
    awayTeam: 'Chelsea FC',
    awayTeamId: 't2',
    kickoffAt: '2026-10-17T11:30:00Z',
    status: 'scheduled',
    score: null,
  };

  it('hace GET /matches con el token en Authorization y sin seguir redirecciones', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () =>
      fakeResponse(200, async () => '{"matches":[]}'),
    );

    const outcome = await probeCatalogRead(BASE, TOKEN, {
      fetchFn,
      monotonicMs: clock.monotonicMs,
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    const headers = new Headers(init?.headers);

    expect(url).toBe(`${BASE}/matches`);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(outcome).toEqual({ kind: 'response', status: 200, body: { matches: [] } });
  });

  it('el token solo viaja en el header: ni en la URL ni en el cuerpo', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => fakeResponse(200, async () => '{}'));

    await probeCatalogRead(BASE, TOKEN, { fetchFn, monotonicMs: clock.monotonicMs });

    const [url, init] = fetchFn.mock.calls[0]!;

    expect(String(url)).not.toContain(TOKEN);
    expect(init?.body).toBeUndefined();
  });

  it('informa el estado recibido aunque no sea 200', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => fakeResponse(503, async () => ''));

    await expect(
      probeCatalogRead(BASE, TOKEN, { fetchFn, monotonicMs: clock.monotonicMs }),
    ).resolves.toMatchObject({ kind: 'response', status: 503 });
  });

  it('un cuerpo que no es JSON llega como undefined: no lanza', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () =>
      fakeResponse(200, async () => '<html>Bad Gateway</html>'),
    );

    await expect(
      probeCatalogRead(BASE, TOKEN, { fetchFn, monotonicMs: clock.monotonicMs }),
    ).resolves.toEqual({ kind: 'response', status: 200, body: undefined });
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

    await expect(
      probeCatalogRead(BASE, TOKEN, { fetchFn, monotonicMs: clock.monotonicMs }),
    ).resolves.toEqual({ kind: 'failed', reason });
  });

  it('si leer el cuerpo falla no hay respuesta completa', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () =>
      fakeResponse(200, async () => {
        throw namedError('TypeError');
      }),
    );

    await expect(
      probeCatalogRead(BASE, TOKEN, { fetchFn, monotonicMs: clock.monotonicMs }),
    ).resolves.toEqual({ kind: 'failed', reason: 'network-error' });
  });

  it('el resultado de un fallo no incluye el token ni el mensaje del error', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error(`falló con Authorization: Bearer ${TOKEN}`);
    });

    const outcome = await probeCatalogRead(BASE, TOKEN, {
      fetchFn,
      monotonicMs: clock.monotonicMs,
    });

    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  describe('hasExpectedMatchesSchema', () => {
    it('acepta la lista vacía: un catálogo sin partidos sigue siendo una lectura válida', () => {
      expect(hasExpectedMatchesSchema({ matches: [] })).toBe(true);
    });

    it('acepta partidos con sus campos canónicos, con marcador o sin él', () => {
      expect(hasExpectedMatchesSchema({ matches: [MATCH] })).toBe(true);
      expect(
        hasExpectedMatchesSchema({
          matches: [{ ...MATCH, status: 'finished', score: { home: 2, away: 1 } }],
        }),
      ).toBe(true);
    });

    it('una API anterior que no envía el marcador también es válida', () => {
      const withoutScore: Partial<typeof MATCH> = { ...MATCH };

      delete withoutScore.score;

      expect(hasExpectedMatchesSchema({ matches: [withoutScore] })).toBe(true);
    });

    it.each(['scheduled', 'live', 'finished', 'postponed', 'cancelled'])(
      'acepta el estado %s',
      (status) => {
        expect(hasExpectedMatchesSchema({ matches: [{ ...MATCH, status }] })).toBe(true);
      },
    );

    it.each<[string, unknown]>([
      ['undefined', undefined],
      ['null', null],
      ['un texto', 'matches'],
      ['una lista sin envoltorio', [MATCH]],
      ['sin matches', {}],
      ['matches que no es lista', { matches: {} }],
      ['un partido que no es objeto', { matches: ['m1'] }],
      ['un partido sin id', { matches: [{ ...MATCH, id: undefined }] }],
      ['un id que no es texto', { matches: [{ ...MATCH, id: 1 }] }],
      ['un equipo que no es texto', { matches: [{ ...MATCH, homeTeam: null }] }],
      ['un estado desconocido', { matches: [{ ...MATCH, status: 'otro' }] }],
      ['un marcador negativo', { matches: [{ ...MATCH, score: { home: -1, away: 0 } }] }],
      ['un marcador decimal', { matches: [{ ...MATCH, score: { home: 1.5, away: 0 } }] }],
      ['un marcador incompleto', { matches: [{ ...MATCH, score: { home: 1 } }] }],
      ['un buen partido y uno inválido', { matches: [MATCH, { id: 'm2' }] }],
    ])('rechaza %s', (_label, body) => {
      expect(hasExpectedMatchesSchema(body)).toBe(false);
    });
  });
});
