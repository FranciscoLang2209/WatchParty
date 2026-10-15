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
