import { readWebEnv } from '../../lib/env';
import { ReactionsApiError, type ReactionState, type ReactionsErrorKind } from './types';

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que la UI no invente copy.
 */
const MESSAGES: Record<ReactionsErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese comentario.',
  server: 'No pudimos actualizar la reacción. Intentá de nuevo.',
  cancelled: 'Operación cancelada.',
};

const KIND_BY_API_CODE: Record<string, ReactionsErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//rooms`. */
function reactionUrl(roomId: string, commentId: string): string {
  const base = readWebEnv().apiBaseUrl.replace(/\/+$/, '');
  // Los ids son opacos: se codifican sin interpretarlos.
  return `${base}/rooms/${encodeURIComponent(roomId)}/comments/${encodeURIComponent(commentId)}/reaction`;
}

function fail(kind: ReactionsErrorKind): ReactionsApiError {
  return new ReactionsApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): ReactionsErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<ReactionsApiError> {
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

/**
 * Valida el cuerpo `{ reaction: { count, reacted } }`. Devuelve solo esos dos
 * campos y descarta cualquier extra; ante cualquier otra forma, un conteo no
 * entero, negativo o no finito, o un `reacted` que no sea booleano, falla.
 */
function toReaction(body: unknown): ReactionState {
  if (typeof body !== 'object' || body === null) throw fail('server');

  const { reaction } = body as Record<string, unknown>;

  if (typeof reaction !== 'object' || reaction === null) throw fail('server');

  const { count, reacted } = reaction as Record<string, unknown>;

  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    typeof reacted !== 'boolean'
  ) {
    throw fail('server');
  }

  return { count, reacted };
}

/**
 * Pide `method` sobre la reacción propia de un comentario y devuelve el
 * `{ count, reacted }` que confirma el servidor. No se manda cuerpo: la
 * persona sale del bearer, nunca de un `userId` del cliente.
 */
async function request(
  roomId: string,
  commentId: string,
  method: 'GET' | 'PUT' | 'DELETE',
  accessToken: string,
  signal?: AbortSignal,
): Promise<ReactionState> {
  let response: Response;

  try {
    response = await fetch(reactionUrl(roomId, commentId), {
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
    return toReaction(await response.json());
  } catch (error) {
    if (error instanceof ReactionsApiError) throw error;

    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }
}

/**
 * Lee el conteo de reacciones de un comentario y si la persona autenticada
 * reaccionó (WAT-206). Un fallo de lectura siempre se lanza: nunca se resuelve
 * como un conteo en cero.
 */
export function getReaction(
  roomId: string,
  commentId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ReactionState> {
  return request(roomId, commentId, 'GET', accessToken, signal);
}

/**
 * Marca (`reacted: true`, `PUT`) o quita (`reacted: false`, `DELETE`) la
 * reacción de la persona autenticada.
 *
 * Devuelve el estado que confirma el servidor, que es el único que la pantalla
 * debe mostrar: no el que se pidió.
 */
export function setReaction(
  roomId: string,
  commentId: string,
  reacted: boolean,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ReactionState> {
  return request(roomId, commentId, reacted ? 'PUT' : 'DELETE', accessToken, signal);
}
