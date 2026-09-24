import { readWebEnv } from '../../lib/env';
import {
  CommentsApiError,
  type CommentEnvelope,
  type CommentInput,
  type CommentsEnvelope,
  type CommentsErrorKind,
  type RoomComment,
} from './types';

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el form y la lista no inventen copy.
 */
const MESSAGES: Record<CommentsErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos esa sala.',
  invalid: 'Revisá el comentario: hay algo que no podemos guardar.',
  server: 'No pudimos guardar el comentario. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, CommentsErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  VALIDATION_ERROR: 'invalid',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//rooms`. */
function commentsUrl(roomId: string): string {
  const base = readWebEnv().apiBaseUrl.replace(/\/+$/, '');
  // El id es opaco: se codifica sin interpretarlo.
  return `${base}/rooms/${encodeURIComponent(roomId)}/comments`;
}

function fail(kind: CommentsErrorKind): CommentsApiError {
  return new CommentsApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): CommentsErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 400 || status === 422) return 'invalid';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<CommentsApiError> {
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

/** Se queda con los cuatro campos canónicos y descarta cualquier extra. */
function toComment(value: unknown): RoomComment {
  if (typeof value !== 'object' || value === null) throw fail('server');

  const { id, roomId, body, createdAt } = value as Record<string, unknown>;

  if (
    typeof id !== 'string' ||
    typeof roomId !== 'string' ||
    typeof body !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw fail('server');
  }

  return { id, roomId, body, createdAt };
}

interface RequestOptions {
  method: 'GET' | 'POST';
  accessToken: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(
  url: string,
  { method, accessToken, body, signal }: RequestOptions,
): Promise<T> {
  let response: Response;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // Cancelar no es un fallo de red: la pantalla que desmonta no debe avisar.
    throw isAbortError(error) ? fail('cancelled') : fail('network');
  }

  if (!response.ok) throw await toApiError(response);

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }
}

/** Comentarios de una sala, en el orden que ya viene del servidor. */
export async function listComments(
  roomId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RoomComment[]> {
  const body = await request<CommentsEnvelope>(commentsUrl(roomId), {
    method: 'GET',
    accessToken,
    signal,
  });

  if (typeof body !== 'object' || body === null || !Array.isArray(body.comments)) {
    throw fail('server');
  }

  return body.comments.map(toComment);
}

/**
 * Publica un comentario.
 *
 * `input.clientRequestId` lo genera quien llama —el formulario, una vez por
 * intento de envío— no este módulo: así, si el formulario reintenta tras un
 * fallo de red, reusa la misma clave y el backend nunca duplica el
 * comentario (idempotencia, WAT-147).
 */
export async function postComment(
  roomId: string,
  input: CommentInput,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RoomComment> {
  const body = await request<CommentEnvelope>(commentsUrl(roomId), {
    method: 'POST',
    accessToken,
    body: input,
    signal,
  });

  if (typeof body !== 'object' || body === null) throw fail('server');

  return toComment(body.comment);
}
