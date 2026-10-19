import { readWebEnv } from '../../lib/env';
import { parseMatch } from '../matches/api';
import {
  WatchedApiError,
  type WatchedErrorKind,
  type WatchedHistoryCursor,
  type WatchedHistoryItem,
  type WatchedHistoryPage,
} from './types';

type Messages = Record<WatchedErrorKind, string>;

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el detalle no invente copy.
 */
const MESSAGES: Messages = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese partido.',
  server: 'No pudimos actualizar el partido visto. Intentá de nuevo.',
  cancelled: 'Operación cancelada.',
};

/** Mismo criterio para el historial (WAT-218): sólo cambia lo que no se pudo hacer. */
const HISTORY_MESSAGES: Messages = {
  ...MESSAGES,
  'not-found': 'No encontramos tu historial.',
  server: 'No pudimos cargar tu historial. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, WatchedErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//matches`. */
function apiUrl(path: string): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function watchedUrl(matchId: string): string {
  // El id es opaco: se codifica sin interpretarlo.
  return apiUrl(`/matches/${encodeURIComponent(matchId)}/watched`);
}

function fail(kind: WatchedErrorKind, messages: Messages = MESSAGES): WatchedApiError {
  return new WatchedApiError(kind, messages[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): WatchedErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response, messages: Messages): Promise<WatchedApiError> {
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

/** Valida el cuerpo `{ watched }` y devuelve el estado final que confirma el servidor. */
function toWatched(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) throw fail('server');

  const { watched } = body as Record<string, unknown>;

  if (typeof watched !== 'boolean') throw fail('server');

  return watched;
}

/** Se queda con `match` y `watchedAt`, y descarta cualquier extra. */
function toHistoryItem(value: unknown): WatchedHistoryItem {
  if (typeof value !== 'object' || value === null) throw fail('server', HISTORY_MESSAGES);

  const { match: rawMatch, watchedAt } = value as Record<string, unknown>;
  const match = parseMatch(rawMatch);

  if (!match || typeof watchedAt !== 'string') throw fail('server', HISTORY_MESSAGES);

  return { match, watchedAt };
}

/** `null` o ausente es «no hay más páginas»; cualquier otra forma es un fallo. */
function toHistoryCursor(value: unknown): WatchedHistoryCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw fail('server', HISTORY_MESSAGES);

  const { watchedAt, matchId } = value as Record<string, unknown>;

  if (typeof watchedAt !== 'string' || typeof matchId !== 'string') {
    throw fail('server', HISTORY_MESSAGES);
  }

  return { watchedAt, matchId };
}

/**
 * Pide `method` sobre `url` y devuelve el cuerpo JSON sin validar. No se manda
 * cuerpo: la persona sale del bearer, nunca de un `userId` del cliente.
 */
async function request(
  url: string,
  method: 'GET' | 'PUT' | 'DELETE',
  accessToken: string,
  signal: AbortSignal | undefined,
  messages: Messages,
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
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
 * Lee si la persona autenticada marcó el partido como visto (WAT-197). Un
 * fallo de lectura siempre se lanza: nunca se resuelve como `false`.
 */
export async function getWatched(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return toWatched(await request(watchedUrl(matchId), 'GET', accessToken, signal, MESSAGES));
}

/**
 * Marca (`watched: true`, `PUT`) o deshace (`watched: false`, `DELETE`) el
 * partido visto de la persona autenticada.
 *
 * Devuelve el estado que confirma el servidor, que es el único que la pantalla
 * debe mostrar: no el que se pidió.
 */
export async function setWatched(
  matchId: string,
  watched: boolean,
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return toWatched(
    await request(watchedUrl(matchId), watched ? 'PUT' : 'DELETE', accessToken, signal, MESSAGES),
  );
}

/** Tamaño de página del historial propio (WAT-218). La API acepta hasta 50. */
export const WATCHED_HISTORY_PAGE_SIZE = 20;

/**
 * Una página del historial de vistos de la persona autenticada (WAT-217), del
 * más reciente al más antiguo, de a `WATCHED_HISTORY_PAGE_SIZE`. Sin `cursor`
 * es la primera; con `cursor`, la que sigue a esa posición.
 *
 * Los dos campos del cursor viajan siempre juntos, tal cual los devolvió el
 * servidor, y `URLSearchParams` codifica el «+» del offset horario.
 */
export async function listWatchedHistoryPage(
  accessToken: string,
  { cursor, signal }: { cursor?: WatchedHistoryCursor; signal?: AbortSignal } = {},
): Promise<WatchedHistoryPage> {
  const params = new URLSearchParams({ limit: String(WATCHED_HISTORY_PAGE_SIZE) });

  if (cursor) {
    params.set('beforeWatchedAt', cursor.watchedAt);
    params.set('beforeMatchId', cursor.matchId);
  }

  const body = await request(
    apiUrl(`/me/watched-matches?${params}`),
    'GET',
    accessToken,
    signal,
    HISTORY_MESSAGES,
  );

  if (typeof body !== 'object' || body === null) throw fail('server', HISTORY_MESSAGES);

  const { items, nextCursor } = body as Record<string, unknown>;

  if (!Array.isArray(items)) throw fail('server', HISTORY_MESSAGES);

  return { items: items.map(toHistoryItem), nextCursor: toHistoryCursor(nextCursor) };
}
