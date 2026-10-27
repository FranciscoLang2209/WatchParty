import { readWebEnv } from '../../lib/env';
import { StatisticsApiError, type StatisticsErrorKind, type UserStatistics } from './types';

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el perfil no invente copy.
 */
const MESSAGES: Record<StatisticsErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  server: 'No pudimos cargar tu actividad. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, StatisticsErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//me`. */
function apiUrl(path: string): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function fail(kind: StatisticsErrorKind): StatisticsApiError {
  return new StatisticsApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<StatisticsApiError> {
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
  const byStatus = response.status === 401 || response.status === 403 ? 'unauthorized' : 'server';

  return fail(mapped ?? byStatus);
}

/** Un total válido es un entero no negativo; cualquier otra cosa es un fallo. */
function isTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Se queda con los tres totales y descarta cualquier extra. */
function toStatistics(body: unknown): UserStatistics {
  const statistics =
    typeof body === 'object' && body !== null
      ? (body as { statistics?: unknown }).statistics
      : undefined;

  if (typeof statistics !== 'object' || statistics === null) throw fail('server');

  const { watchedMatches, ratings, comments } = statistics as Record<string, unknown>;

  if (!isTotal(watchedMatches) || !isTotal(ratings) || !isTotal(comments)) throw fail('server');

  return { watchedMatches, ratings, comments };
}

/**
 * Totales de actividad de la persona autenticada (WAT-232). La identidad sale
 * del bearer: no se manda `userId`. Ceros es una respuesta válida; un fallo
 * siempre se lanza, nunca se resuelve como ceros.
 */
export async function getOwnStatistics(
  accessToken: string,
  signal?: AbortSignal,
): Promise<UserStatistics> {
  let response: Response;

  try {
    response = await fetch(apiUrl('/me/statistics'), {
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

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }

  return toStatistics(body);
}
