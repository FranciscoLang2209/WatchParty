import { readWebEnv } from '../../lib/env';
import { RatingsApiError, isRatingValue, type RatingValue, type RatingsErrorKind } from './types';

type Messages = Record<RatingsErrorKind, string>;

/**
 * Mensajes presentables. El error del servidor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que el detalle no invente copy.
 */
const SAVE_MESSAGES: Messages = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese partido.',
  conflict: 'Sólo se puede calificar un partido finalizado y marcado como visto.',
  validation: 'La calificación debe ser un número entero de 1 a 5.',
  server: 'No pudimos guardar tu calificación. Intentá de nuevo.',
  cancelled: 'Operación cancelada.',
};

/** Mismo criterio para la lectura: sólo cambia lo que no se pudo hacer. */
const READ_MESSAGES: Messages = {
  ...SAVE_MESSAGES,
  server: 'No pudimos cargar tu calificación. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, RatingsErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  VALIDATION_ERROR: 'validation',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//matches`. */
function apiUrl(path: string): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function ratingUrl(matchId: string): string {
  // El id es opaco: se codifica sin interpretarlo.
  return apiUrl(`/matches/${encodeURIComponent(matchId)}/rating`);
}

function fail(kind: RatingsErrorKind, messages: Messages): RatingsApiError {
  return new RatingsApiError(kind, messages[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): RatingsErrorKind {
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
async function toApiError(response: Response, messages: Messages): Promise<RatingsApiError> {
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

/**
 * Valida el cuerpo `{ rating }`. La nota que confirma el servidor es la única
 * que la pantalla debe mostrar, así que cualquier otra forma es un fallo: un
 * decimal o un 7 nunca se muestran como si fueran una nota.
 */
function toRating(body: unknown, messages: Messages): RatingValue | null {
  if (typeof body !== 'object' || body === null) throw fail('server', messages);

  const { rating } = body as Record<string, unknown>;

  if (rating === null) return null;
  if (!isRatingValue(rating)) throw fail('server', messages);

  return rating;
}

/**
 * Pide `method` sobre `url` y devuelve el cuerpo JSON sin validar. La persona
 * sale del bearer, nunca de un `userId` del cliente: el único dato que viaja en
 * el cuerpo es la nota.
 */
async function request(
  url: string,
  method: 'GET' | 'PUT',
  accessToken: string,
  signal: AbortSignal | undefined,
  messages: Messages,
  body?: { rating: RatingValue },
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
 * Lee la nota de la persona autenticada para el partido (WAT-212). `null`
 * significa que la lectura se completó y confirmó que todavía no calificó: un
 * fallo de lectura siempre se lanza, nunca se resuelve como `null`.
 */
export async function getRating(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RatingValue | null> {
  return toRating(
    await request(ratingUrl(matchId), 'GET', accessToken, signal, READ_MESSAGES),
    READ_MESSAGES,
  );
}

/**
 * Guarda o edita la nota de la persona autenticada (`PUT`). Devuelve la nota
 * que confirma el servidor, que es la única que la pantalla debe mostrar: no la
 * que se pidió.
 *
 * Una nota fuera de 1–5 o decimal ni siquiera sale del cliente: falla como
 * `validation`, igual que si la hubiera rechazado el servidor.
 */
export async function saveRating(
  matchId: string,
  rating: RatingValue,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RatingValue> {
  if (!isRatingValue(rating)) throw fail('validation', SAVE_MESSAGES);

  const confirmed = toRating(
    await request(ratingUrl(matchId), 'PUT', accessToken, signal, SAVE_MESSAGES, { rating }),
    SAVE_MESSAGES,
  );

  // Un PUT exitoso siempre devuelve la nota guardada, nunca `null`.
  if (confirmed === null) throw fail('server', SAVE_MESSAGES);

  return confirmed;
}
