import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRating, saveRating } from './api';
import { RatingsApiError, isCancelled, isRatingValue, type RatingValue } from './types';

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

async function failureOf(promise: Promise<unknown>): Promise<RatingsApiError> {
  try {
    await promise;
  } catch (error) {
    return error as RatingsApiError;
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

describe('isRatingValue', () => {
  it.each([1, 2, 3, 4, 5])('acepta %i', (value) => {
    expect(isRatingValue(value)).toBe(true);
  });

  it.each([0, 6, -1, 3.5, Number.NaN, '4', null, undefined, true, [4]])('rechaza %s', (value) => {
    expect(isRatingValue(value)).toBe(false);
  });
});

describe('getRating', () => {
  it('manda GET /matches/:matchId/rating con bearer y sin cuerpo', async () => {
    respondWith({ rating: 4 });

    await getRating(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/rating`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requestInit().body).toBeUndefined();
  });

  it('codifica el id sin interpretarlo y tolera barras finales en la base', async () => {
    envMock.mockReturnValue({ apiBaseUrl: `${API_BASE}///` });
    respondWith({ rating: null });

    await getRating('id con/espacios', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/id%20con%2Fespacios/rating`);
  });

  it.each([1, 2, 3, 4, 5])('devuelve la nota %i que confirma el servidor', async (rating) => {
    respondWith({ rating });

    expect(await getRating(MATCH_ID, TOKEN)).toBe(rating);
  });

  it('devuelve null cuando todavía no calificó', async () => {
    respondWith({ rating: null });

    expect(await getRating(MATCH_ID, TOKEN)).toBeNull();
  });

  it('pasa la señal de cancelación a fetch', async () => {
    respondWith({ rating: null });
    const controller = new AbortController();

    await getRating(MATCH_ID, TOKEN, controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });

  it.each([
    ['nota decimal', { rating: 3.5 }],
    ['nota fuera de rango', { rating: 7 }],
    ['nota como texto', { rating: '4' }],
    ['campo ausente', {}],
    ['cuerpo vacío', null],
    ['cuerpo que no es objeto', 'ok'],
  ])('un cuerpo con %s es un fallo del servidor, nunca una nota', async (_label, body) => {
    respondWith(body);

    const error = await failureOf(getRating(MATCH_ID, TOKEN));

    expect(error).toBeInstanceOf(RatingsApiError);
    expect(error.kind).toBe('server');
    expect(error.message).toBe('No pudimos cargar tu calificación. Intentá de nuevo.');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [500, 'server'],
  ])('un %i sin cuerpo útil se traduce a %s', async (status, kind) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status,
      json: async () => {
        throw new Error('no es JSON');
      },
    } as unknown as Response);

    expect((await failureOf(getRating(MATCH_ID, TOKEN))).kind).toBe(kind);
  });

  it('una caída de red es un fallo de red, nunca null', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await failureOf(getRating(MATCH_ID, TOKEN));

    expect(error.kind).toBe('network');
  });

  it('cancelar no es un fallo de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await failureOf(getRating(MATCH_ID, TOKEN));

    expect(isCancelled(error)).toBe(true);
  });
});

describe('saveRating', () => {
  it('manda PUT con bearer y un cuerpo JSON con solo la nota', async () => {
    respondWith({ rating: 4 });

    await saveRating(MATCH_ID, 4, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/rating`);
    expect(requestInit().method).toBe('PUT');
    const headers = new Headers(requestInit().headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(requestInit().body as string)).toEqual({ rating: 4 });
  });

  it('devuelve la nota que confirma el servidor, no la pedida', async () => {
    respondWith({ rating: 2 });

    expect(await saveRating(MATCH_ID, 5, TOKEN)).toBe(2);
  });

  it.each([0, 6, -1, 3.5, Number.NaN])(
    'una nota %s no sale del cliente: falla como validation sin pedir nada',
    async (value) => {
      const error = await failureOf(saveRating(MATCH_ID, value as RatingValue, TOKEN));

      expect(error.kind).toBe('validation');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('un PUT que devuelve null es un fallo del servidor, nunca una nota guardada', async () => {
    respondWith({ rating: null });

    expect((await failureOf(saveRating(MATCH_ID, 4, TOKEN))).kind).toBe('server');
  });

  it('un cuerpo inválido es un fallo del servidor', async () => {
    respondWith({ rating: 9 });

    const error = await failureOf(saveRating(MATCH_ID, 4, TOKEN));

    expect(error.kind).toBe('server');
    expect(error.message).toBe('No pudimos guardar tu calificación. Intentá de nuevo.');
  });

  it.each([
    ['UNAUTHORIZED', 401, 'unauthorized'],
    ['NOT_FOUND', 404, 'not-found'],
    ['CONFLICT', 409, 'conflict'],
    ['VALIDATION_ERROR', 400, 'validation'],
    ['INTERNAL_ERROR', 500, 'server'],
  ])('el código %s del contrato de errores se traduce a %s', async (code, status, kind) => {
    respondWith({ error: { code, message: 'texto interno del servidor' } }, { status });

    const error = await failureOf(saveRating(MATCH_ID, 4, TOKEN));

    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain('texto interno');
  });

  it.each([
    [409, 'conflict'],
    [400, 'validation'],
    [404, 'not-found'],
    [401, 'unauthorized'],
    [502, 'server'],
  ])('si el cuerpo no es el esperado cae al status %i → %s', async (status, kind) => {
    respondWith('<html>bad gateway</html>', { status });

    expect((await failureOf(saveRating(MATCH_ID, 4, TOKEN))).kind).toBe(kind);
  });

  it('una caída de red es un fallo de red', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect((await failureOf(saveRating(MATCH_ID, 4, TOKEN))).kind).toBe('network');
  });

  it('cancelar no es un fallo de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    expect(isCancelled(await failureOf(saveRating(MATCH_ID, 4, TOKEN)))).toBe(true);
  });
});
