import { readWebEnv } from '../../lib/env';
import {
  ReviewsApiError,
  toReviewBody,
  type OwnReview,
  type PublicReview,
  type ReviewsErrorKind,
  type ReviewsPage,
} from './types';

type Messages = Record<ReviewsErrorKind, string>;

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el detalle no invente copy.
 */
const SAVE_MESSAGES: Messages = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese partido.',
  conflict: 'Para reseñar un partido tiene que estar finalizado, marcado como visto y calificado.',
  validation: 'La reseña debe tener entre 1 y 500 caracteres.',
  server: 'No pudimos guardar tu reseña. Intentá de nuevo.',
  cancelled: 'Operación cancelada.',
};

/** Mismo criterio para la lectura: sólo cambia lo que no se pudo hacer. */
const READ_MESSAGES: Messages = {
  ...SAVE_MESSAGES,
  server: 'No pudimos cargar tu reseña. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const DELETE_MESSAGES: Messages = {
  ...SAVE_MESSAGES,
  server: 'No pudimos eliminar tu reseña. Intentá de nuevo.',
};

const LIST_MESSAGES: Messages = {
  ...SAVE_MESSAGES,
  validation: 'No pudimos pedir esa página de opiniones.',
  server: 'No pudimos cargar las opiniones. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, ReviewsErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  VALIDATION_ERROR: 'validation',
  INTERNAL_ERROR: 'server',
};

/** Límites de `limit` en el listado, replicados de la API (1 a 50). */
export const REVIEWS_PAGE_MIN_LIMIT = 1;
export const REVIEWS_PAGE_MAX_LIMIT = 50;

/** Quita las barras finales de la base para no construir `//matches`. */
function apiUrl(path: string): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function ownReviewUrl(matchId: string): string {
  // El id es opaco: se codifica sin interpretarlo.
  return apiUrl(`/matches/${encodeURIComponent(matchId)}/review`);
}

function matchReviewsUrl(matchId: string): string {
  return apiUrl(`/matches/${encodeURIComponent(matchId)}/reviews`);
}

function fail(kind: ReviewsErrorKind, messages: Messages): ReviewsApiError {
  return new ReviewsApiError(kind, messages[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): ReviewsErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400) return 'validation';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response, messages: Messages): Promise<ReviewsApiError> {
  let code: unknown;

  try {
    const body: unknown = await response.json();
    code =
      typeof body === 'object' && body !== null
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined;
  } catch {
    code = undefined;
  }

  const mapped = typeof code === 'string' ? KIND_BY_API_CODE[code] : undefined;

  return fail(mapped ?? kindFromStatus(response.status), messages);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Valida el cuerpo `{ review }` de la reseña propia: `null` si no hay texto, o
 * `{ body, createdAt, updatedAt }`. Cualquier otra forma es un fallo: un cuerpo
 * incoherente nunca se muestra como reseña ni como «sin reseña». Se arma un
 * objeto nuevo con los tres campos, así que nada más que venga en el cuerpo
 * llega a la pantalla.
 */
function toOwnReview(body: unknown, messages: Messages): OwnReview | null {
  if (typeof body !== 'object' || body === null) throw fail('server', messages);

  const { review } = body as Record<string, unknown>;

  if (review === null) return null;
  if (typeof review !== 'object') throw fail('server', messages);

  const { body: text, createdAt, updatedAt } = review as Record<string, unknown>;

  if (!isNonEmptyString(text) || !isNonEmptyString(createdAt) || !isNonEmptyString(updatedAt)) {
    throw fail('server', messages);
  }

  return { body: text, createdAt, updatedAt };
}

/** Una opinión pública: sólo `authorName`, `body` y `createdAt`, descartando el resto. */
function toPublicReview(value: unknown, messages: Messages): PublicReview {
  if (typeof value !== 'object' || value === null) throw fail('server', messages);

  const { authorName, body, createdAt } = value as Record<string, unknown>;

  if (!isNonEmptyString(authorName) || !isNonEmptyString(body) || !isNonEmptyString(createdAt)) {
    throw fail('server', messages);
  }

  return { authorName, body, createdAt };
}

/**
 * Valida `{ reviews, nextCursor }`. `nextCursor` es `null` (o ausente) cuando
 * no quedan páginas; si viene, tiene que ser un texto no vacío, porque un
 * cursor vacío haría que la paginación pida siempre la misma página.
 */
function toReviewsPage(body: unknown, messages: Messages): ReviewsPage {
  if (typeof body !== 'object' || body === null) throw fail('server', messages);

  const { reviews, nextCursor } = body as Record<string, unknown>;

  if (!Array.isArray(reviews)) throw fail('server', messages);

  if (nextCursor !== undefined && nextCursor !== null && !isNonEmptyString(nextCursor)) {
    throw fail('server', messages);
  }

  return {
    reviews: reviews.map((review) => toPublicReview(review, messages)),
    nextCursor: nextCursor ?? null,
  };
}

/**
 * Pide `method` sobre `url` y devuelve el cuerpo JSON sin validar. La persona
 * sale del bearer, nunca de un `userId` del cliente: el único dato que viaja en
 * el cuerpo es el texto de la reseña.
 */
async function request(
  url: string,
  method: 'GET' | 'PUT' | 'DELETE',
  accessToken: string,
  signal: AbortSignal | undefined,
  messages: Messages,
  body?: { body: string },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // Cancelar no es un fallo de red: la pantalla que desmonta no debe avisar.
    throw isAbortError(error) ? fail('cancelled', messages) : fail('network', messages);
  }

  if (!response.ok) throw await toApiError(response, messages);

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw isAbortError(error) ? fail('cancelled', messages) : fail('server', messages);
  }
}

/**
 * Lee la reseña de la persona autenticada para el partido (WAT-253). `null`
 * significa que la lectura se completó y confirmó que todavía no reseñó: un
 * fallo de lectura siempre se lanza, nunca se resuelve como `null`.
 */
export async function getOwnReview(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<OwnReview | null> {
  return toOwnReview(
    await request(ownReviewUrl(matchId), 'GET', accessToken, signal, READ_MESSAGES),
    READ_MESSAGES,
  );
}

/**
 * Guarda o edita la reseña de la persona autenticada (`PUT`, WAT-254). Devuelve
 * la reseña que confirma el servidor, que es la única que la pantalla debe
 * mostrar: no el texto que se pidió.
 *
 * Un texto vacío, de sólo espacios o de más de 500 caracteres ni siquiera sale
 * del cliente: falla como `validation`, igual que si lo hubiera rechazado el
 * servidor. Se envía sin los espacios exteriores.
 */
export async function saveOwnReview(
  matchId: string,
  body: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<OwnReview> {
  const text = toReviewBody(body);

  if (text === null) throw fail('validation', SAVE_MESSAGES);

  const confirmed = toOwnReview(
    await request(ownReviewUrl(matchId), 'PUT', accessToken, signal, SAVE_MESSAGES, {
      body: text,
    }),
    SAVE_MESSAGES,
  );

  // Un PUT exitoso siempre devuelve la reseña guardada, nunca `null`.
  if (confirmed === null) throw fail('server', SAVE_MESSAGES);

  return confirmed;
}

/**
 * Elimina el texto de la reseña propia (`DELETE`, WAT-255). Es idempotente:
 * borrar sin haber reseñado también resuelve. Sólo resuelve si el servidor
 * confirmó `{ review: null }`; cualquier otra respuesta es un fallo.
 */
export async function deleteOwnReview(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const remaining = toOwnReview(
    await request(ownReviewUrl(matchId), 'DELETE', accessToken, signal, DELETE_MESSAGES),
    DELETE_MESSAGES,
  );

  if (remaining !== null) throw fail('server', DELETE_MESSAGES);
}

/**
 * Una página de opiniones públicas del partido, de la más reciente a la más
 * antigua (WAT-256). Sin `cursor` es la primera; con `cursor`, la que sigue.
 *
 * `cursor` es el `nextCursor` de la página anterior, tal cual: es opaco y se
 * codifica para el query sin interpretarlo. `limit` es opcional (el servidor
 * usa 20); fuera de 1–50 o no entero falla como `validation` sin pedir.
 */
export async function listMatchReviews(
  matchId: string,
  accessToken: string,
  { cursor, limit, signal }: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<ReviewsPage> {
  const params = new URLSearchParams();

  if (limit !== undefined) {
    if (
      !Number.isInteger(limit) ||
      limit < REVIEWS_PAGE_MIN_LIMIT ||
      limit > REVIEWS_PAGE_MAX_LIMIT
    ) {
      throw fail('validation', LIST_MESSAGES);
    }

    params.set('limit', String(limit));
  }

  if (cursor !== undefined) {
    if (!isNonEmptyString(cursor)) throw fail('validation', LIST_MESSAGES);

    params.set('cursor', cursor);
  }

  const query = params.toString();
  const url = `${matchReviewsUrl(matchId)}${query === '' ? '' : `?${query}`}`;

  return toReviewsPage(
    await request(url, 'GET', accessToken, signal, LIST_MESSAGES),
    LIST_MESSAGES,
  );
}
