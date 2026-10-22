export interface ProbeDeps {
  fetchFn: typeof fetch;
  /** Reloj monotónico en milisegundos: no lo afectan los ajustes del reloj de pared. */
  monotonicMs: () => number;
  timeoutMs?: number;
}

/**
 * Resultado de un sondeo. `response` significa que llegó una respuesta COMPLETA
 * (estado y cuerpo leído hasta el final); `failed` que no hubo respuesta, y
 * eso no dice nada del servicio: puede ser la red del propio reporter.
 */
export type ProbeOutcome =
  | { kind: 'response'; status: number; latencyMs: number }
  | { kind: 'failed'; reason: 'timeout' | 'network-error' };

const DEFAULT_TIMEOUT_MS = 10_000;

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

// GET sin credenciales de ningún tipo: estos sondeos no usan cuentas ni tokens.
async function probe(url: string, deps: ProbeDeps): Promise<ProbeOutcome> {
  const startedMs = deps.monotonicMs();

  try {
    const response = await deps.fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    // La latencia llega hasta el final del cuerpo, no hasta los headers.
    await response.text();

    return { kind: 'response', status: response.status, latencyMs: deps.monotonicMs() - startedMs };
  } catch (error) {
    return { kind: 'failed', reason: isTimeout(error) ? 'timeout' : 'network-error' };
  }
}

/** `GET /health` de la API. */
export function probeHealth(baseUrl: string, deps: ProbeDeps): Promise<ProbeOutcome> {
  return probe(`${baseUrl}/health`, deps);
}

/** `GET /matches` SIN token: el guard de autenticación debe rechazarlo con 401. */
export function probeAuthGuard(baseUrl: string, deps: ProbeDeps): Promise<ProbeOutcome> {
  return probe(`${baseUrl}/matches`, deps);
}

/**
 * Resultado del sondeo autenticado. `body` es el JSON ya leído, o `undefined`
 * si la respuesta no era JSON.
 */
export type CatalogReadProbe =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'failed'; reason: 'timeout' | 'network-error' };

/**
 * `GET /matches` CON el token de la cuenta técnica de lectura. El token solo
 * viaja en el header de este pedido, y una redirección no se sigue para no
 * reenviarlo a otro destino.
 */
export async function probeCatalogRead(
  baseUrl: string,
  accessToken: string,
  deps: ProbeDeps,
): Promise<CatalogReadProbe> {
  try {
    const response = await deps.fetchFn(`${baseUrl}/matches`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown;

    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    return { kind: 'response', status: response.status, body };
  } catch (error) {
    return { kind: 'failed', reason: isTimeout(error) ? 'timeout' : 'network-error' };
  }
}

// Estados que el producto puede devolver (`MatchStatus` del módulo de partidos).
const MATCH_STATUSES: readonly unknown[] = [
  'scheduled',
  'live',
  'finished',
  'postponed',
  'cancelled',
];

function isGoalCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isExpectedMatch(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;

  const match = value as Record<string, unknown>;
  const { score } = match;
  const scoreOk =
    score === null ||
    score === undefined ||
    (typeof score === 'object' &&
      isGoalCount((score as Record<string, unknown>).home) &&
      isGoalCount((score as Record<string, unknown>).away));

  return (
    ['id', 'homeTeam', 'homeTeamId', 'awayTeam', 'awayTeamId', 'kickoffAt'].every(
      (key) => typeof match[key] === 'string',
    ) &&
    MATCH_STATUSES.includes(match.status) &&
    scoreOk
  );
}

/**
 * El esquema que devuelve `GET /matches`: `{ matches: [...] }` con partidos de
 * campos canónicos. Una lista vacía es válida: un catálogo sin partidos sigue
 * siendo una lectura que funciona.
 */
export function hasExpectedMatchesSchema(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;

  const { matches } = body as Record<string, unknown>;

  return Array.isArray(matches) && matches.every(isExpectedMatch);
}
