import { readWebEnv } from '../../lib/env';
import { isMatchStatus } from './format';
import {
  MatchesApiError,
  type Match,
  type MatchEnvelope,
  type MatchesEnvelope,
  type MatchesErrorKind,
} from './types';

/**
 * Mensajes presentables. El error del proveedor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que Home y detalle no inventen copy.
 */
const MESSAGES: Record<MatchesErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese partido.',
  server: 'No pudimos cargar los partidos. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, MatchesErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//matches`. */
function matchesUrl(path = ''): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}/matches${path}`;
}

function fail(kind: MatchesErrorKind): MatchesApiError {
  return new MatchesApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): MatchesErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<MatchesApiError> {
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

/** Se queda con los cinco campos canónicos y descarta cualquier extra. */
function toMatch(value: unknown): Match {
  if (typeof value !== 'object' || value === null) throw fail('server');

  const { id, homeTeam, awayTeam, kickoffAt, status } = value as Record<string, unknown>;

  if (
    typeof id !== 'string' ||
    typeof homeTeam !== 'string' ||
    typeof awayTeam !== 'string' ||
    typeof kickoffAt !== 'string' ||
    !isMatchStatus(status)
  ) {
    throw fail('server');
  }

  return { id, homeTeam, awayTeam, kickoffAt, status };
}

async function request<T>(url: string, accessToken: string, signal?: AbortSignal): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'GET',
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
    return (await response.json()) as T;
  } catch (error) {
    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }
}

export async function listMatches(accessToken: string, signal?: AbortSignal): Promise<Match[]> {
  const body = await request<MatchesEnvelope>(matchesUrl(), accessToken, signal);

  if (typeof body !== 'object' || body === null || !Array.isArray(body.matches)) {
    throw fail('server');
  }

  return body.matches.map(toMatch);
}

export async function getMatch(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Match> {
  // El id es opaco: se codifica sin interpretarlo.
  const body = await request<MatchEnvelope>(
    matchesUrl(`/${encodeURIComponent(matchId)}`),
    accessToken,
    signal,
  );

  if (typeof body !== 'object' || body === null) throw fail('server');

  return toMatch(body.match);
}
