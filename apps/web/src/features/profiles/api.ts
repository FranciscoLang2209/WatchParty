import { readWebEnv } from '../../lib/env';
import {
  ProfilesApiError,
  type Profile,
  type ProfileEnvelope,
  type ProfileInput,
  type ProfilesErrorKind,
  type TeamOption,
  type TeamsEnvelope,
} from './types';

/**
 * Mensajes presentables. El error del proveedor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que la pantalla de perfil no invente copy.
 */
const MESSAGES: Record<ProfilesErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos lo que buscabas.',
  invalid: 'Revisá los datos: hay algún campo que no podemos guardar.',
  server: 'No pudimos cargar tu perfil. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, ProfilesErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  VALIDATION_ERROR: 'invalid',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//teams`. */
function apiUrl(path: string): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function fail(kind: ProfilesErrorKind): ProfilesApiError {
  return new ProfilesApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): ProfilesErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 400 || status === 422) return 'invalid';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<ProfilesApiError> {
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

/** Se queda con los tres campos canónicos y descarta cualquier extra. */
function toProfile(value: unknown): Profile {
  if (typeof value !== 'object' || value === null) throw fail('server');

  const { displayName, bio, favoriteTeamId } = value as Record<string, unknown>;

  if (
    typeof displayName !== 'string' ||
    typeof bio !== 'string' ||
    !(typeof favoriteTeamId === 'string' || favoriteTeamId === null)
  ) {
    throw fail('server');
  }

  return { displayName, bio, favoriteTeamId };
}

function toTeamOption(value: unknown): TeamOption {
  if (typeof value !== 'object' || value === null) throw fail('server');

  const { id, name } = value as Record<string, unknown>;

  if (typeof id !== 'string' || typeof name !== 'string') throw fail('server');

  return { id, name };
}

interface RequestOptions {
  method: 'GET' | 'PUT';
  accessToken: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(url: string, { method, accessToken, body, signal }: RequestOptions) {
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

/**
 * Perfil propio.
 *
 * `null` es una respuesta válida: la persona todavía no completó su perfil. Eso
 * no es un 404 ni un error, y la pantalla no puede tratarlo como tal.
 */
export async function getOwnProfile(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Profile | null> {
  const body = await request<ProfileEnvelope>(apiUrl('/me/profile'), {
    method: 'GET',
    accessToken,
    signal,
  });

  if (typeof body !== 'object' || body === null || !('profile' in body)) throw fail('server');

  return body.profile === null ? null : toProfile(body.profile);
}

/** Equipos elegibles como favorito. Nunca se derivan de los partidos. */
export async function listTeams(accessToken: string, signal?: AbortSignal): Promise<TeamOption[]> {
  const body = await request<TeamsEnvelope>(apiUrl('/teams'), {
    method: 'GET',
    accessToken,
    signal,
  });

  if (typeof body !== 'object' || body === null || !Array.isArray(body.teams)) throw fail('server');

  return body.teams.map(toTeamOption);
}

/**
 * Guarda el perfil propio y devuelve el que responde la API.
 *
 * Lo que se muestra después de guardar es la respuesta, no lo que se mandó: el
 * backend puede normalizar. Un PUT exitoso siempre trae perfil, nunca `null`.
 */
export async function saveOwnProfile(
  input: ProfileInput,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Profile> {
  const body = await request<ProfileEnvelope>(apiUrl('/me/profile'), {
    method: 'PUT',
    accessToken,
    body: input,
    signal,
  });

  if (typeof body !== 'object' || body === null) throw fail('server');

  return toProfile(body.profile);
}
