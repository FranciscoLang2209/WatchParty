import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOwnStatistics } from './api';
import { StatisticsApiError, isCancelled } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const fetchMock = vi.fn();

function respondWith(body: unknown, status = 200) {
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

async function failureOf(promise: Promise<unknown>): Promise<StatisticsApiError> {
  try {
    await promise;
  } catch (error) {
    return error as StatisticsApiError;
  }
  throw new Error('Debería haber fallado.');
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.mockReturnValue({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: `${API_BASE}/`,
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOwnStatistics', () => {
  it('pide GET /me/statistics a la Node API con el bearer y sin userId', async () => {
    respondWith({ statistics: { watchedMatches: 3, ratings: 2, comments: 5 } });

    await getOwnStatistics(TOKEN);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];

    expect(url).toBe(`${API_BASE}/me/statistics`);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined();
  });

  it('devuelve los tres totales y descarta cualquier extra', async () => {
    respondWith({ statistics: { watchedMatches: 3, ratings: 2, comments: 5, userId: 'x' } });

    await expect(getOwnStatistics(TOKEN)).resolves.toEqual({
      watchedMatches: 3,
      ratings: 2,
      comments: 5,
    });
  });

  it('acepta los ceros de una cuenta sin actividad', async () => {
    respondWith({ statistics: { watchedMatches: 0, ratings: 0, comments: 0 } });

    await expect(getOwnStatistics(TOKEN)).resolves.toEqual({
      watchedMatches: 0,
      ratings: 0,
      comments: 0,
    });
  });

  it.each([
    ['sin envoltorio', { watchedMatches: 1, ratings: 1, comments: 1 }],
    ['un total ausente', { statistics: { watchedMatches: 1, ratings: 1 } }],
    ['un total como texto', { statistics: { watchedMatches: '1', ratings: 1, comments: 1 } }],
    ['un total negativo', { statistics: { watchedMatches: -1, ratings: 1, comments: 1 } }],
    ['un total decimal', { statistics: { watchedMatches: 1.5, ratings: 1, comments: 1 } }],
  ])('trata %s como fallo del servidor, nunca como ceros', async (_caso, body) => {
    respondWith(body);

    const error = await failureOf(getOwnStatistics(TOKEN));

    expect(error).toBeInstanceOf(StatisticsApiError);
    expect(error.kind).toBe('server');
  });

  it('traduce un 401 en sesión vencida', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, 401);

    const error = await failureOf(getOwnStatistics(TOKEN));

    expect(error.kind).toBe('unauthorized');
    expect(error.message).toBe('La sesión venció. Iniciá sesión nuevamente.');
  });

  it('traduce un 500 con mensaje presentable, sin el detalle del servidor', async () => {
    respondWith({ error: { code: 'INTERNAL_ERROR', message: 'relation does not exist' } }, 500);

    const error = await failureOf(getOwnStatistics(TOKEN));

    expect(error.kind).toBe('server');
    expect(error.message).toBe('No pudimos cargar tu actividad. Intentá de nuevo.');
  });

  it('cae al status HTTP si el cuerpo del error no es JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    expect((await failureOf(getOwnStatistics(TOKEN))).kind).toBe('unauthorized');
  });

  it('distingue un fallo de red de una cancelación', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await failureOf(getOwnStatistics(TOKEN))).kind).toBe('network');

    fetchMock.mockRejectedValueOnce(abortError());
    expect(isCancelled(await failureOf(getOwnStatistics(TOKEN)))).toBe(true);
  });
});
