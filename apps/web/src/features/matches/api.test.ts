import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMatch, listMatches } from './api';
import { MatchesApiError, isCancelled, isUnauthorized } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const partido = {
  id: 'match-1',
  homeTeam: 'River Plate',
  awayTeam: 'Boca Juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
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

describe('listMatches', () => {
  it('consulta GET /matches con bearer', async () => {
    respondWith({ matches: [partido] });

    await listMatches(TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('no duplica la barra si la base termina en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}///`,
    });
    respondWith({ matches: [] });

    await listMatches(TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches`);
  });

  it('devuelve el arreglo que viene dentro de {matches}', async () => {
    respondWith({ matches: [partido] });

    await expect(listMatches(TOKEN)).resolves.toEqual([partido]);
  });

  it('acepta una lista vacía como respuesta legítima', async () => {
    respondWith({ matches: [] });

    await expect(listMatches(TOKEN)).resolves.toEqual([]);
  });

  it('descarta los campos que no son del contrato', async () => {
    respondWith({ matches: [{ ...partido, score: '1-1', minute: 68 }] });

    const [primero] = await listMatches(TOKEN);

    expect(primero).toEqual(partido);
    expect(primero).not.toHaveProperty('score');
    expect(primero).not.toHaveProperty('minute');
  });

  it('rechaza un estado que no es del dominio en vez de dejarlo pasar', async () => {
    respondWith({ matches: [{ ...partido, status: 'halftime' }] });

    await expect(listMatches(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un cuerpo sin la clave matches', async () => {
    respondWith({ data: [partido] });

    await expect(listMatches(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('getMatch', () => {
  it('consulta /matches/:id y consume {match}', async () => {
    respondWith({ match: partido });

    await expect(getMatch('match-1', TOKEN)).resolves.toEqual(partido);
    expect(requestUrl()).toBe(`${API_BASE}/matches/match-1`);
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('codifica el id sin interpretarlo, porque es opaco', async () => {
    respondWith({ match: partido });

    await getMatch('river/boca 2026?x=1', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/river%2Fboca%202026%3Fx%3D1`);
  });
});

describe('Errores diferenciados', () => {
  it('un 401 es sesión vencida, no un error genérico', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, { status: 401 });

    const error = await listMatches(TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchesApiError);
    expect(isUnauthorized(error)).toBe(true);
    expect((error as MatchesApiError).message).toBe('La sesión venció. Iniciá sesión nuevamente.');
  });

  it('un 404 es «no encontrado», no un error genérico', async () => {
    respondWith(
      { error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' } },
      { status: 404 },
    );

    await expect(getMatch('inexistente', TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('un 500 es error de servidor', async () => {
    respondWith(
      { error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' } },
      { status: 500 },
    );

    await expect(listMatches(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('cae al status HTTP si el cuerpo no respeta el contrato de errores', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    await expect(listMatches(TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('una caída de red se distingue de una respuesta HTTP fallida', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(listMatches(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });

  it('ninguna respuesta fallida se convierte en lista vacía', async () => {
    for (const status of [401, 404, 500]) {
      vi.clearAllMocks();
      respondWith({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, { status });

      const resultado = await listMatches(TOKEN).catch(() => 'lanzó');

      expect(resultado).toBe('lanzó');
    }
  });

  it('no filtra el mensaje interno del servidor', async () => {
    respondWith(
      { error: { code: 'INTERNAL_ERROR', message: 'ECONNREFUSED at /matches in pool#3' } },
      { status: 500 },
    );

    const error = (await listMatches(TOKEN).catch((e: unknown) => e)) as MatchesApiError;

    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('pool#3');
  });
});

describe('Cancelación', () => {
  it('un abort se marca como cancelado, no como error de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await listMatches(TOKEN, new AbortController().signal).catch((e: unknown) => e);

    expect(isCancelled(error)).toBe(true);
    expect((error as MatchesApiError).kind).not.toBe('network');
  });

  it('propaga el signal al fetch para que la pantalla pueda cancelar', async () => {
    const controller = new AbortController();
    respondWith({ matches: [] });

    await listMatches(TOKEN, controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });

  it('también distingue la cancelación al leer el cuerpo', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw abortError();
      },
    } as unknown as Response);

    await expect(listMatches(TOKEN)).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
