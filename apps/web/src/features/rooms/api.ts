import { readWebEnv } from '../../lib/env';
import { RoomsApiError, type PublicRoom, type RoomEnvelope, type RoomsErrorKind } from './types';

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el detalle y la sala no inventen copy.
 */
const MESSAGES: Record<RoomsErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos esa sala.',
  server: 'No pudimos abrir la sala. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, RoomsErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//rooms`. */
function apiUrl(path: string): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function fail(kind: RoomsErrorKind): RoomsApiError {
  return new RoomsApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): RoomsErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<RoomsApiError> {
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

/** Valida el envelope `{ room }` y se queda con los tres campos de `PublicRoom`. */
function toRoom(body: unknown): PublicRoom {
  if (typeof body !== 'object' || body === null) throw fail('server');

  const room = (body as Partial<RoomEnvelope>).room as unknown;

  if (typeof room !== 'object' || room === null) throw fail('server');

  const { id, matchId, createdAt } = room as Record<string, unknown>;

  if (typeof id !== 'string' || typeof matchId !== 'string' || typeof createdAt !== 'string') {
    throw fail('server');
  }

  return { id, matchId, createdAt };
}

async function request(
  url: string,
  method: 'GET' | 'POST',
  accessToken: string,
  signal?: AbortSignal,
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
    throw isAbortError(error) ? fail('cancelled') : fail('network');
  }

  if (!response.ok) throw await toApiError(response);

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }
}

/**
 * Entra a la sala pública de un partido: el servidor la crea si todavía no
 * existe o devuelve la que ya había. No se manda cuerpo: la persona sale del
 * bearer, nunca de un `userId` del cliente.
 */
export async function enterRoom(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<PublicRoom> {
  // El id es opaco: se codifica sin interpretarlo.
  const body = await request(
    apiUrl(`/matches/${encodeURIComponent(matchId)}/room`),
    'POST',
    accessToken,
    signal,
  );

  return toRoom(body);
}

/** Vuelve a cargar una sala existente por su id, p. ej. al abrir la URL directo. */
export async function getRoom(
  roomId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<PublicRoom> {
  const body = await request(
    apiUrl(`/rooms/${encodeURIComponent(roomId)}`),
    'GET',
    accessToken,
    signal,
  );

  return toRoom(body);
}
