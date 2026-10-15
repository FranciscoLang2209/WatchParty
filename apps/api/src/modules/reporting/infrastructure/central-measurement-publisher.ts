import type { ReporterEnv } from '../domain/kpi-catalog.js';
import { serializeBatchPayload, validateMeasurementBatch } from '../domain/measurement-batch.js';

/** Intentos TOTALES por envío: el primero más hasta dos reintentos. */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** Espera fija antes de cada reintento (el reintento n usa el valor n-1). */
const RETRY_DELAYS_MS = [1_000, 2_000] as const;

const ATTEMPT_TIMEOUT_MS = 10_000;

// PostgREST central: inserta y, ante una fila ya existente, la IGNORA. Nunca se
// pide `merge-duplicates` ni se usa PATCH/PUT: el primer valor aceptado gana.
const MEASUREMENT_PATH = '/rest/v1/measurement?on_conflict=project_id,kpi_id,date,env';
const PREFER_HEADER = 'resolution=ignore-duplicates';

const URL_VAR = 'REPORTER_CENTRAL_URL';
const PUBLISHABLE_KEY_VAR = 'REPORTER_CENTRAL_PUBLISHABLE_KEY';
const PROJECT_KEY_VAR = 'REPORTER_CENTRAL_PROJECT_KEY';

/** Motivos de fallo: códigos fijos, nunca texto del servidor ni del driver. */
export type PublishFailureReason =
  | 'config-missing'
  | 'config-invalid'
  | 'invalid-batch'
  | 'network-error'
  | 'timeout'
  | 'server-error'
  | 'client-error'
  | 'unexpected-status';

type AttemptOutcome =
  'accepted' | Exclude<PublishFailureReason, 'config-missing' | 'config-invalid' | 'invalid-batch'>;

/** Qué pasó en un intento. El estado HTTP es un número: no lleva cuerpo ni headers. */
export interface AttemptRecord {
  attempt: number;
  outcome: AttemptOutcome;
  status?: number;
}

/**
 * Resultado sanitizado de un envío, listo para archivar con `JSON.stringify`.
 * Solo contiene códigos fijos, números, el `run_id` y el ambiente: nunca claves,
 * URLs ni cuerpos de respuesta.
 */
export interface PublishResult {
  ok: boolean;
  /** Presente solo si `ok` es `false`. */
  reason?: PublishFailureReason;
  run_id: string | null;
  env: ReporterEnv | null;
  /** Cantidad de mediciones del lote. */
  rows: number;
  attempts: AttemptRecord[];
  /**
   * Siempre `false`: un HTTP 2xx NO confirma la recepción de los valores. La
   * verificación consultando las mediciones propias es parte de la activación
   * (WAT-209), no de este cliente.
   */
  verified: false;
}

interface CentralConfig {
  endpoint: string;
  publishableKey: string;
  projectKey: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// Cualquier clave de rol de servicio, sea del formato nuevo (`sb_secret_…`) o un
// JWT legado con `role: service_role`, jamás se envía a la plataforma central.
function looksLikeServiceRoleKey(value: string): boolean {
  if (/^sb_secret_/i.test(value)) return true;

  const parts = value.split('.');

  if (parts.length !== 3) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));

    return (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { role?: unknown }).role === 'service_role'
    );
  } catch {
    return false;
  }
}

type ConfigResult =
  { ok: true; config: CentralConfig } | { ok: false; reason: 'config-missing' | 'config-invalid' };

/**
 * Lee la configuración del ambiente. Sin valor por defecto: si falta algo, no
 * hay envío. La URL debe ser https (http solo en loopback, para el servidor
 * simulado de las pruebas) para que las claves nunca viajen en claro, y ninguna
 * clave puede parecer de rol de servicio.
 */
export function readCentralPublisherConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const rawUrl = env[URL_VAR]?.trim();
  const publishableKey = env[PUBLISHABLE_KEY_VAR]?.trim();
  const projectKey = env[PROJECT_KEY_VAR]?.trim();

  if (!rawUrl || !publishableKey || !projectKey) {
    return { ok: false, reason: 'config-missing' };
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    // No se propaga el error original: su mensaje incluye la URL.
    return { ok: false, reason: 'config-invalid' };
  }

  const secureEnough =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));

  if (
    !secureEnough ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    looksLikeServiceRoleKey(publishableKey) ||
    looksLikeServiceRoleKey(projectKey)
  ) {
    return { ok: false, reason: 'config-invalid' };
  }

  return {
    ok: true,
    config: { endpoint: `${url.origin}${MEASUREMENT_PATH}`, publishableKey, projectKey },
  };
}

export interface PublisherDeps {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function outcomeFromStatus(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) return 'accepted';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';

  return 'unexpected-status';
}

async function attemptOnce(
  config: CentralConfig,
  body: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ outcome: AttemptOutcome; status?: number }> {
  let response: Response;

  try {
    response = await fetchFn(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.publishableKey,
        'X-Project-Key': config.projectKey,
        Prefer: PREFER_HEADER,
      },
      body,
      // Una redirección nunca se sigue: reenviaría las claves a otro destino.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { outcome: isTimeout(error) ? 'timeout' : 'network-error' };
  }

  try {
    // El cuerpo no se lee ni se archiva; solo se libera la conexión.
    await response.body?.cancel();
  } catch {
    // Ya hay estado HTTP: un fallo al liberar el cuerpo no cambia el resultado.
  }

  return { outcome: outcomeFromStatus(response.status), status: response.status };
}

/**
 * Publica un lote en el PostgREST central (`POST /rest/v1/measurement`).
 *
 * - El cuerpo sale de `serializeBatchPayload` (WAT-200), que revalida: un lote
 *   inválido no se envía. Es EXACTAMENTE el mismo JSON, con el mismo `run_id`, en
 *   cada intento.
 * - Hasta `MAX_PUBLISH_ATTEMPTS` intentos totales, solo ante falta de respuesta
 *   (red o timeout) o 5xx. Un 4xx falla sin reintentar: se corrige antes de repetir.
 * - Nunca actualiza mediciones: con `ignore-duplicates` gana el primer valor aceptado.
 * - No imprime ni devuelve claves. El resultado es archivable tal cual.
 */
export async function publishMeasurements(
  rows: unknown,
  deps: PublisherDeps = {},
): Promise<PublishResult> {
  const {
    env = process.env,
    fetchFn = fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    timeoutMs = ATTEMPT_TIMEOUT_MS,
  } = deps;

  const failed = (
    reason: PublishFailureReason,
    base: Pick<PublishResult, 'run_id' | 'env' | 'rows'> = { run_id: null, env: null, rows: 0 },
  ): PublishResult => ({ ok: false, reason, ...base, attempts: [], verified: false });

  const configResult = readCentralPublisherConfig(env);

  if (!configResult.ok) {
    return failed(configResult.reason);
  }

  const validation = validateMeasurementBatch(rows);
  const payload = validation.ok ? serializeBatchPayload(validation.rows) : null;

  if (!validation.ok || !payload?.ok) {
    return failed('invalid-batch');
  }

  const first = validation.rows[0]!;
  const identity = { run_id: first.run_id, env: first.env, rows: validation.rows.length };
  const attempts: AttemptRecord[] = [];

  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2]!);

    const result = await attemptOnce(configResult.config, payload.json, fetchFn, timeoutMs);

    attempts.push({
      attempt,
      outcome: result.outcome,
      ...(result.status === undefined ? {} : { status: result.status }),
    });

    if (result.outcome === 'accepted') {
      return { ok: true, ...identity, attempts, verified: false };
    }

    // Solo la falta de respuesta y los 5xx se reintentan.
    const retryable =
      result.outcome === 'network-error' ||
      result.outcome === 'timeout' ||
      result.outcome === 'server-error';

    if (!retryable) break;
  }

  const last = attempts[attempts.length - 1]!;

  return {
    ok: false,
    reason: last.outcome as PublishFailureReason,
    ...identity,
    attempts,
    verified: false,
  };
}
