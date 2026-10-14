import { readWebEnv } from '../../lib/env';
import { WatchedApiError, type WatchedErrorKind } from './types';

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el detalle no invente copy.
 */
const MESSAGES: Record<WatchedErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese partido.',
  server: 'No pudimos actualizar el partido visto. Intentá de nuevo.',
  cancelled: 'Operación cancelada.',
};

const KIND_BY_API_CODE: Record<string, WatchedErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//matches`. */
function watchedUrl(matchId: string): string {
  const base = readWebEnv().apiBaseUrl.replace(/\/+$/, '');
  // El id es opaco: se codifica sin interpretarlo.
  return `${base}/matches/${encodeURIComponent(matchId)}/watched`;
}

function fail(kind: WatchedErrorKind): WatchedApiError {
  return new WatchedApiError(kind, MESSAGES[kind]);
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
async function toApiError(response: Response): Promise<WatchedApiError> {
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

  return fail(mapped ?? kindFromStatus(response.status));
}

/** Valida el cuerpo `{ watched }` y devuelve el estado final que confirma el servidor. */
function toWatched(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) throw fail('server');

  const { watched } = body as Record<string, unknown>;

  if (typeof watched !== 'boolean') throw fail('server');

  return watched;
}

/**
 * Pide `method` sobre el partido visto propio y devuelve el `{ watched }` que
 * confirma el servidor. No se manda cuerpo: la persona sale del bearer, nunca
 * de un `userId` del cliente.
 */
async function request(
  matchId: string,
  method: 'GET' | 'PUT' | 'DELETE',
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let response: Response;

  try {
    response = await fetch(watchedUrl(matchId), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
  } catch (error) {
    // Cancelar no es un fallo de red: la pantalla que desmonta no debe avisar.
    throw isAbortError(error) ? fail('cancelled') : fail('network');
  }

  if (!response.ok) throw await toApiError(response);

  try {
    return toWatched(await response.json());
  } catch (error) {
    if (error instanceof WatchedApiError) throw error;

    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }
}

/**
 * Lee si la persona autenticada marcó el partido como visto (WAT-197). Un
 * fallo de lectura siempre se lanza: nunca se resuelve como `false`.
 */
export function getWatched(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return request(matchId, 'GET', accessToken, signal);
}

/**
 * Marca (`watched: true`, `PUT`) o deshace (`watched: false`, `DELETE`) el
 * partido visto de la persona autenticada.
 *
 * Devuelve el estado que confirma el servidor, que es el único que la pantalla
 * debe mostrar: no el que se pidió.
 */
export function setWatched(
  matchId: string,
  watched: boolean,
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return request(matchId, watched ? 'PUT' : 'DELETE', accessToken, signal);
}
