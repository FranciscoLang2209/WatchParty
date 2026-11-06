import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteOwnReview, getOwnReview, listMatchReviews, saveOwnReview } from './api';
import {
  ReviewsApiError,
  isCancelled,
  isNotFound,
  isRecoverable,
  isUnauthorized,
  toReviewBody,
} from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const fetchMock = vi.fn();

const OWN = {
  body: 'Gran partido',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
};

const PUBLIC = [
  { authorName: 'Ana', body: 'Gran partido', createdAt: '2026-11-02T10:00:00.000Z' },
  { authorName: 'Usuario de WatchParty', body: 'Aburrido', createdAt: '2026-11-01T10:00:00.000Z' },
];

function respondWith(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;

  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function respondWithoutJson(status: number) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('no es JSON');
    },
  } as unknown as Response);
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

async function failureOf(promise: Promise<unknown>): Promise<ReviewsApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ReviewsApiError;
  }
  throw new Error('Debería haber fallado.');
}

/** Las cuatro operaciones, para probar lo que comparten con una sola tabla. */
const OPERATIONS = [
  {
    name: 'getOwnReview',
    run: (signal?: AbortSignal) => getOwnReview(MATCH_ID, TOKEN, signal),
    okBody: { review: OWN },
    serverMessage: 'No pudimos cargar tu reseña. Intentá de nuevo.',
  },
  {
    name: 'saveOwnReview',
    run: (signal?: AbortSignal) => saveOwnReview(MATCH_ID, 'Gran partido', TOKEN, signal),
    okBody: { review: OWN },
    serverMessage: 'No pudimos guardar tu reseña. Intentá de nuevo.',
  },
  {
    name: 'deleteOwnReview',
    run: (signal?: AbortSignal) => deleteOwnReview(MATCH_ID, TOKEN, signal),
    okBody: { review: null },
    serverMessage: 'No pudimos eliminar tu reseña. Intentá de nuevo.',
  },
  {
    name: 'listMatchReviews',
    run: (signal?: AbortSignal) => listMatchReviews(MATCH_ID, TOKEN, { signal }),
    okBody: { reviews: PUBLIC, nextCursor: null },
    serverMessage: 'No pudimos cargar las opiniones. Intentá de nuevo.',
  },
] as const;

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

describe('toReviewBody', () => {
  it('devuelve el texto sin los espacios exteriores y respeta los interiores', () => {
    expect(toReviewBody('  \n Gran   partido \t ')).toBe('Gran   partido');
  });

  it('acepta 1 y 500 caracteres', () => {
    expect(toReviewBody('a')).toBe('a');
    expect(toReviewBody('a'.repeat(500))).toBe('a'.repeat(500));
  });

  it('cuenta caracteres y no unidades UTF-16: 500 emojis entran y 501 no', () => {
    expect(toReviewBody('🏆'.repeat(500))).not.toBeNull();
    expect(toReviewBody('🏆'.repeat(501))).toBeNull();
  });

  it('mide el largo tras recortar: 500 caracteres con espacios alrededor entran', () => {
    expect(toReviewBody(` ${'a'.repeat(500)} `)).toBe('a'.repeat(500));
  });

  it.each(['', '   ', ' \n\t ', 'a'.repeat(501), null, undefined, 5, true, ['a'], { body: 'a' }])(
    'rechaza %j',
    (value) => {
      expect(toReviewBody(value)).toBeNull();
    },
  );
});

describe('getOwnReview', () => {
  it('manda GET /matches/:matchId/review con bearer y sin cuerpo', async () => {
    respondWith({ review: OWN });

    await getOwnReview(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/review`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requestInit().body).toBeUndefined();
  });

  it('devuelve la reseña que confirma el servidor', async () => {
    respondWith({ review: OWN });

    expect(await getOwnReview(MATCH_ID, TOKEN)).toEqual(OWN);
  });

  it('devuelve null cuando todavía no reseñó', async () => {
    respondWith({ review: null });

    expect(await getOwnReview(MATCH_ID, TOKEN)).toBeNull();
  });

  it('devuelve solo body, createdAt y updatedAt: descarta cualquier otro dato', async () => {
    respondWith({ review: { ...OWN, userId: 'u-1', email: 'a@b.c', rating: 5 }, userId: 'u-1' });

    expect(await getOwnReview(MATCH_ID, TOKEN)).toStrictEqual(OWN);
  });

  it('codifica el id sin interpretarlo y tolera barras finales en la base', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'x',
      supabaseAnonKey: 'y',
      apiBaseUrl: `${API_BASE}//`,
    });
    respondWith({ review: null });

    await getOwnReview('a/b?c#d', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/a%2Fb%3Fc%23d/review`);
  });

  it.each([
    ['reseña sin texto', { review: { ...OWN, body: '' } }],
    ['texto que no es string', { review: { ...OWN, body: 5 } }],
    ['sin createdAt', { review: { body: OWN.body, updatedAt: OWN.updatedAt } }],
    ['sin updatedAt', { review: { body: OWN.body, createdAt: OWN.createdAt } }],
    ['fecha numérica', { review: { ...OWN, createdAt: 123 } }],
    ['review ausente', {}],
    ['review que no es objeto', { review: 'hola' }],
    ['cuerpo vacío', null],
    ['cuerpo que no es objeto', 'ok'],
  ])(
    'un cuerpo con %s es un fallo del servidor, nunca una reseña ni «sin reseña»',
    async (_l, body) => {
      respondWith(body);

      const error = await failureOf(getOwnReview(MATCH_ID, TOKEN));

      expect(error).toBeInstanceOf(ReviewsApiError);
      expect(error.kind).toBe('server');
      expect(error.message).toBe('No pudimos cargar tu reseña. Intentá de nuevo.');
    },
  );
});

describe('saveOwnReview', () => {
  it('manda PUT con bearer y un cuerpo JSON con solo el texto', async () => {
    respondWith({ review: OWN });

    await saveOwnReview(MATCH_ID, 'Gran partido', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/review`);
    expect(requestInit().method).toBe('PUT');
    const headers = new Headers(requestInit().headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(requestInit().body as string)).toEqual({ body: 'Gran partido' });
  });

  it('envía el texto sin los espacios exteriores', async () => {
    respondWith({ review: OWN });

    await saveOwnReview(MATCH_ID, '  Gran partido \n', TOKEN);

    expect(JSON.parse(requestInit().body as string)).toEqual({ body: 'Gran partido' });
  });

  it('devuelve la reseña que confirma el servidor, no el texto pedido', async () => {
    respondWith({ review: { ...OWN, body: 'Texto del servidor' } });

    expect((await saveOwnReview(MATCH_ID, 'Otro texto', TOKEN)).body).toBe('Texto del servidor');
  });

  it('nunca manda un userId ni un autor', async () => {
    respondWith({ review: OWN });

    await saveOwnReview(MATCH_ID, 'Gran partido', TOKEN);

    expect(Object.keys(JSON.parse(requestInit().body as string))).toEqual(['body']);
  });

  it.each(['', '   ', '\n\t', 'a'.repeat(501), '🏆'.repeat(501)])(
    'un texto inválido (%#) falla como validation sin pedir nada',
    async (body) => {
      const error = await failureOf(saveOwnReview(MATCH_ID, body, TOKEN));

      expect(error.kind).toBe('validation');
      expect(error.message).toBe('La reseña debe tener entre 1 y 500 caracteres.');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('un texto que no es string tampoco sale del cliente', async () => {
    const error = await failureOf(saveOwnReview(MATCH_ID, 5 as unknown as string, TOKEN));

    expect(error.kind).toBe('validation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un PUT que devuelve null es un fallo del servidor, nunca una reseña guardada', async () => {
    respondWith({ review: null });

    expect((await failureOf(saveOwnReview(MATCH_ID, 'Gran partido', TOKEN))).kind).toBe('server');
  });

  it('un cuerpo inválido es un fallo del servidor', async () => {
    respondWith({ review: { body: 'x' } });

    expect((await failureOf(saveOwnReview(MATCH_ID, 'Gran partido', TOKEN))).kind).toBe('server');
  });

  it('un 409 es conflict, con el copy de las tres condiciones', async () => {
    respondWith({ error: { code: 'CONFLICT', message: 'x' } }, { status: 409 });

    const error = await failureOf(saveOwnReview(MATCH_ID, 'Gran partido', TOKEN));

    expect(error.kind).toBe('conflict');
    expect(error.message).toBe(
      'Para reseñar un partido tiene que estar finalizado, marcado como visto y calificado.',
    );
  });
});

describe('deleteOwnReview', () => {
  it('manda DELETE con bearer y sin cuerpo', async () => {
    respondWith({ review: null });

    await deleteOwnReview(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/review`);
    expect(requestInit().method).toBe('DELETE');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requestInit().body).toBeUndefined();
    expect(new Headers(requestInit().headers).has('Content-Type')).toBe(false);
  });

  it('resuelve sin valor cuando el servidor confirma { review: null }', async () => {
    respondWith({ review: null });

    expect(await deleteOwnReview(MATCH_ID, TOKEN)).toBeUndefined();
  });

  it('codifica el id sin interpretarlo', async () => {
    respondWith({ review: null });

    await deleteOwnReview('a/b', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/a%2Fb/review`);
  });

  it.each([
    ['una reseña que sigue ahí', { review: OWN }],
    ['review ausente', {}],
    ['cuerpo vacío', null],
    ['cuerpo que no es objeto', 'ok'],
  ])('%s no cuenta como borrado: es un fallo del servidor', async (_l, body) => {
    respondWith(body);

    const error = await failureOf(deleteOwnReview(MATCH_ID, TOKEN));

    expect(error.kind).toBe('server');
    expect(error.message).toBe('No pudimos eliminar tu reseña. Intentá de nuevo.');
  });
});

describe('listMatchReviews', () => {
  it('manda GET /matches/:matchId/reviews con bearer, sin cuerpo y sin query por defecto', async () => {
    respondWith({ reviews: [], nextCursor: null });

    await listMatchReviews(MATCH_ID, TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/reviews`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requestInit().body).toBeUndefined();
  });

  it('codifica el id del partido sin interpretarlo', async () => {
    respondWith({ reviews: [], nextCursor: null });

    await listMatchReviews('a/b?c', TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/matches/a%2Fb%3Fc/reviews`);
  });

  it('pasa limit en el query', async () => {
    respondWith({ reviews: [], nextCursor: null });

    await listMatchReviews(MATCH_ID, TOKEN, { limit: 7 });

    expect(requestUrl()).toBe(`${API_BASE}/matches/${MATCH_ID}/reviews?limit=7`);
  });

  it('codifica el cursor opaco: «+», «/», «=» y «&» no rompen el query ni se interpretan', async () => {
    respondWith({ reviews: [], nextCursor: null });
    const cursor = 'ab+cd/ef==&limit=50#x y';

    await listMatchReviews(MATCH_ID, TOKEN, { cursor, limit: 3 });

    const url = new URL(requestUrl());
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('3');
    expect([...url.searchParams.keys()].sort()).toEqual(['cursor', 'limit']);
    expect(requestUrl()).toContain('cursor=ab%2Bcd%2Fef%3D%3D%26limit%3D50%23x+y');
  });

  it.each([1, 20, 50])('acepta limit %i', async (limit) => {
    respondWith({ reviews: [], nextCursor: null });

    await listMatchReviews(MATCH_ID, TOKEN, { limit });

    expect(new URL(requestUrl()).searchParams.get('limit')).toBe(String(limit));
  });

  it.each([0, -1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'limit %s falla como validation sin pedir nada',
    async (limit) => {
      const error = await failureOf(listMatchReviews(MATCH_ID, TOKEN, { limit }));

      expect(error.kind).toBe('validation');
      expect(error.message).toBe('No pudimos pedir esa página de opiniones.');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('un cursor vacío falla como validation sin pedir nada', async () => {
    const error = await failureOf(listMatchReviews(MATCH_ID, TOKEN, { cursor: '' }));

    expect(error.kind).toBe('validation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('devuelve las opiniones y el cursor opaco tal cual, sin tocarlo', async () => {
    respondWith({ reviews: PUBLIC, nextCursor: 'Zm9v-_Bar09' });

    expect(await listMatchReviews(MATCH_ID, TOKEN)).toEqual({
      reviews: PUBLIC,
      nextCursor: 'Zm9v-_Bar09',
    });
  });

  it('en la última página nextCursor es null; ausente también cuenta como null', async () => {
    respondWith({ reviews: PUBLIC, nextCursor: null });
    expect((await listMatchReviews(MATCH_ID, TOKEN)).nextCursor).toBeNull();

    respondWith({ reviews: PUBLIC });
    expect((await listMatchReviews(MATCH_ID, TOKEN)).nextCursor).toBeNull();
  });

  it('un partido sin opiniones resuelve una lista vacía sólo si el servidor lo confirmó', async () => {
    respondWith({ reviews: [], nextCursor: null });

    expect(await listMatchReviews(MATCH_ID, TOKEN)).toEqual({ reviews: [], nextCursor: null });
  });

  it('devuelve solo authorName, body y createdAt: descarta ids, emails y notas', async () => {
    respondWith({
      reviews: [{ ...PUBLIC[0], userId: 'u-1', user_id: 'u-1', email: 'a@b.c', rating: 5 }],
      nextCursor: null,
      total: 9,
    });

    const page = await listMatchReviews(MATCH_ID, TOKEN);

    expect(page.reviews[0]).toStrictEqual(PUBLIC[0]);
    expect(Object.keys(page).sort()).toEqual(['nextCursor', 'reviews']);
  });

  it.each([
    ['reviews que no es arreglo', { reviews: 'x', nextCursor: null }],
    ['reviews ausente', { nextCursor: null }],
    ['opinión sin autor', { reviews: [{ body: 'x', createdAt: 'd' }], nextCursor: null }],
    ['opinión sin texto', { reviews: [{ authorName: 'A', createdAt: 'd' }], nextCursor: null }],
    ['opinión sin fecha', { reviews: [{ authorName: 'A', body: 'x' }], nextCursor: null }],
    ['opinión que no es objeto', { reviews: ['x'], nextCursor: null }],
    ['opinión null', { reviews: [null], nextCursor: null }],
    ['autor vacío', { reviews: [{ ...PUBLIC[0], authorName: '' }], nextCursor: null }],
    ['cursor vacío', { reviews: [], nextCursor: '' }],
    ['cursor numérico', { reviews: [], nextCursor: 5 }],
    ['cursor como objeto', { reviews: [], nextCursor: { createdAt: 'x', userId: 'y' } }],
    ['cuerpo vacío', null],
    ['cuerpo que no es objeto', 'ok'],
  ])('un cuerpo con %s es un fallo del servidor, nunca una lista', async (_l, body) => {
    respondWith(body);

    const error = await failureOf(listMatchReviews(MATCH_ID, TOKEN));

    expect(error.kind).toBe('server');
    expect(error.message).toBe('No pudimos cargar las opiniones. Intentá de nuevo.');
  });

  it('una sola opinión inválida invalida la página entera', async () => {
    respondWith({ reviews: [PUBLIC[0], { authorName: 'B' }], nextCursor: null });

    expect((await failureOf(listMatchReviews(MATCH_ID, TOKEN))).kind).toBe('server');
  });
});

describe.each(OPERATIONS)('$name: errores y cancelación', ({ run, okBody, serverMessage }) => {
  it.each([
    ['UNAUTHORIZED', 401, 'unauthorized'],
    ['NOT_FOUND', 404, 'not-found'],
    ['CONFLICT', 409, 'conflict'],
    ['VALIDATION_ERROR', 400, 'validation'],
    ['INTERNAL_ERROR', 500, 'server'],
  ])('el código %s del contrato de errores se traduce a %s', async (code, status, kind) => {
    respondWith({ error: { code, message: 'detalle interno que no debe llegar' } }, { status });

    const error = await failureOf(run());

    expect(error).toBeInstanceOf(ReviewsApiError);
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain('detalle interno');
  });

  it.each([
    [400, 'validation'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [409, 'conflict'],
    [500, 'server'],
    [502, 'server'],
  ])('un %i sin cuerpo útil se traduce a %s', async (status, kind) => {
    respondWithoutJson(status);

    expect((await failureOf(run())).kind).toBe(kind);
  });

  it('un código desconocido cae al status HTTP', async () => {
    respondWith({ error: { code: 'OTRA_COSA' } }, { status: 404 });

    expect((await failureOf(run())).kind).toBe('not-found');
  });

  it('un 500 usa el copy propio de la operación, nunca el del servidor', async () => {
    respondWith(
      { error: { code: 'INTERNAL_ERROR', message: 'postgres://u:pw@host' } },
      { status: 500 },
    );

    const error = await failureOf(run());

    expect(error.message).toBe(serverMessage);
  });

  it('una caída de red es un fallo de red, nunca un éxito', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await failureOf(run());

    expect(error.kind).toBe('network');
    expect(isCancelled(error)).toBe(false);
  });

  it('cancelar en fetch es cancelled, no un fallo de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await failureOf(run());

    expect(error.kind).toBe('cancelled');
    expect(isCancelled(error)).toBe(true);
    expect(isRecoverable(error)).toBe(false);
  });

  it('cancelar mientras se lee el cuerpo también es cancelled', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw abortError();
      },
    } as unknown as Response);

    expect((await failureOf(run())).kind).toBe('cancelled');
  });

  it('una respuesta 200 con un cuerpo que no es JSON es server', async () => {
    respondWithoutJson(200);

    expect((await failureOf(run())).kind).toBe('server');
  });

  it('pasa la señal de cancelación a fetch', async () => {
    respondWith(okBody);
    const controller = new AbortController();

    await run(controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });
});

describe('clasificación de errores', () => {
  const error = (kind: ConstructorParameters<typeof ReviewsApiError>[0]) =>
    new ReviewsApiError(kind, 'x');

  it('distingue cancelación, sesión vencida, no encontrado y error recuperable', () => {
    expect(isCancelled(error('cancelled'))).toBe(true);
    expect(isUnauthorized(error('unauthorized'))).toBe(true);
    expect(isNotFound(error('not-found'))).toBe(true);
    expect(isRecoverable(error('network'))).toBe(true);
    expect(isRecoverable(error('server'))).toBe(true);
  });

  it.each(['conflict', 'validation', 'unauthorized', 'not-found', 'cancelled'] as const)(
    '%s no es recuperable: reintentar igual no sirve',
    (kind) => {
      expect(isRecoverable(error(kind))).toBe(false);
    },
  );

  it('cada helper es falso para cualquier otro tipo de error', () => {
    for (const helper of [isCancelled, isUnauthorized, isNotFound, isRecoverable]) {
      expect(helper(new Error('x'))).toBe(false);
      expect(helper(null)).toBe(false);
      expect(helper(undefined)).toBe(false);
    }
    expect(isCancelled(error('server'))).toBe(false);
    expect(isUnauthorized(error('not-found'))).toBe(false);
    expect(isNotFound(error('unauthorized'))).toBe(false);
  });
});
