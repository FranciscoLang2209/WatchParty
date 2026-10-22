import {
  CatalogMatchCountSourceError,
  type CatalogQueryRead,
} from '../infrastructure/catalog-match-count-source.js';
import {
  probeAuthGuard,
  probeHealth,
  type ProbeDeps,
  type ProbeOutcome,
} from '../infrastructure/api-probes.js';
import { KPI_CATALOG, isValidKpiValue, type KpiId, type KpiKind } from '../domain/kpi-catalog.js';
import { toArgentinaDate } from '../domain/measurement-batch.js';

// Los KPIs, sus tipos, unidades y rangos salen del catálogo (WAT-200): el
// colector no tiene una copia propia. El orden del catálogo es el del artefacto.
const KPI_ORDER: readonly KpiId[] = KPI_CATALOG.map((kpi) => kpi.id);

export interface KpiResult {
  kpi: KpiId;
  kind: KpiKind;
  unit: string;
  value: number;
}

export interface KpiOmission {
  kpi: KpiId;
  /** Motivo fijo y sanitizado: nunca texto del driver, de Postgres ni de la API. */
  reason: string;
}

/**
 * Resultado de una corrida: el corte T y la fecha local (fijados una sola vez),
 * los KPIs con valor y los omitidos con su motivo. Cada KPI aparece en uno solo.
 */
export interface CollectionArtifact {
  /** Corte T, instante UTC en ISO 8601. */
  cutoff: string;
  /** Fecha local `YYYY-MM-DD` en America/Argentina/Buenos_Aires al corte T. */
  localDate: string;
  results: KpiResult[];
  omissions: KpiOmission[];
}

export type ApiBaseUrlConfig =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: 'api-config-missing' | 'api-config-invalid' };

/**
 * Base de la API a sondear, por ambiente (`REPORTER_API_BASE_URL`). Sin valor
 * por defecto: si falta o es inválida, los KPIs HTTP se omiten con motivo.
 */
export function readReporterApiBaseUrl(env: NodeJS.ProcessEnv = process.env): ApiBaseUrlConfig {
  const raw = env.REPORTER_API_BASE_URL?.trim();

  if (!raw) {
    return { ok: false, reason: 'api-config-missing' };
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'api-config-invalid' };
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash) {
    return { ok: false, reason: 'api-config-invalid' };
  }

  return { ok: true, baseUrl: raw.replace(/\/+$/, '') };
}

export interface CollectKpisDeps {
  apiBaseUrl: ApiBaseUrlConfig;
  /**
   * Fuente SQL del catálogo (WAT-198): una sola consulta que trae el conteo y la
   * duración de esa consulta. Falla con `CatalogMatchCountSourceError`.
   */
  readCatalog: (cutoff: Date) => Promise<CatalogQueryRead>;
  fetchFn: typeof fetch;
  /** Reloj de pared: solo para fijar el corte T y la fecha local. */
  now: () => Date;
  /** Reloj monotónico en milisegundos: único origen de las duraciones. */
  monotonicMs: () => number;
}

type Outcome = { value: number } | { reason: string };

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// `health_up`: 200 = 1. Un 5xx es un fallo comprobado del servicio = 0. Cualquier
// otro estado (404, 429...) más probablemente es del reporter (URL mal armada,
// bloqueo de red) que del servicio: no se informa un 0 que no se comprobó. Sin
// respuesta tampoco dice nada del servicio. La latencia solo existe con un 200.
function interpretHealth(probe: ProbeOutcome, outcomes: Partial<Record<KpiId, Outcome>>): void {
  if (probe.kind === 'failed') {
    outcomes.health_up = { reason: probe.reason };
    outcomes.health_response_latency = { reason: probe.reason };
    return;
  }

  if (probe.status === 200) {
    outcomes.health_up = { value: 1 };
    outcomes.health_response_latency = { value: round3(probe.latencyMs) };
    return;
  }

  outcomes.health_response_latency = { reason: 'not-200' };
  outcomes.health_up = probe.status >= 500 ? { value: 0 } : { reason: 'unexpected-status' };
}

// `auth_guard_up`: sin token, el guard debe responder 401 = 1. Cualquier otro
// estado recibido (por ejemplo un 200) significa que el guard no protegió = 0.
function interpretAuthGuard(probe: ProbeOutcome, outcomes: Partial<Record<KpiId, Outcome>>): void {
  outcomes.auth_guard_up =
    probe.kind === 'failed' ? { reason: probe.reason } : { value: probe.status === 401 ? 1 : 0 };
}

/**
 * Colector determinista de los KPIs del catálogo. No publica nada: solo
 * extrae, sondea, calcula y valida. Un KPI sin fuente válida se omite con su
 * motivo; ningún fallo se convierte en cero.
 */
export async function collectKpis(deps: CollectKpisDeps): Promise<CollectionArtifact> {
  const startedMs = deps.monotonicMs();

  // El corte T y la fecha local se fijan una sola vez: todos los KPIs lo comparten.
  const cutoff = deps.now();
  const localDate = toArgentinaDate(cutoff);

  const outcomes: Partial<Record<KpiId, Outcome>> = {};

  if (deps.apiBaseUrl.ok) {
    const probeDeps: ProbeDeps = { fetchFn: deps.fetchFn, monotonicMs: deps.monotonicMs };

    interpretHealth(await probeHealth(deps.apiBaseUrl.baseUrl, probeDeps), outcomes);
    interpretAuthGuard(await probeAuthGuard(deps.apiBaseUrl.baseUrl, probeDeps), outcomes);
  } else {
    const reason = deps.apiBaseUrl.reason;

    outcomes.health_up = { reason };
    outcomes.health_response_latency = { reason };
    outcomes.auth_guard_up = { reason };
  }

  // Una sola consulta alimenta `catalog_match_count` y `catalog_query_latency`. La
  // latencia es la de esa consulta (no la duración total del reporter) y solo
  // existe si terminó bien: ante cualquier fallo se omiten las dos con el mismo motivo.
  try {
    const { count, queryDurationMs } = await deps.readCatalog(cutoff);

    outcomes.catalog_match_count = { value: count.value };
    outcomes.catalog_query_latency = { value: round3(queryDurationMs) };
  } catch (error) {
    const reason =
      error instanceof CatalogMatchCountSourceError ? error.reason : 'unexpected-error';

    outcomes.catalog_match_count = { reason };
    outcomes.catalog_query_latency = { reason };
  }

  // Validación: un valor no finito, negativo o fuera de dominio se omite.
  for (const kpi of KPI_ORDER) {
    const outcome = outcomes[kpi];

    if (outcome && 'value' in outcome && !isValidKpiValue(kpi, outcome.value)) {
      outcomes[kpi] = { reason: 'invalid-value' };
    }
  }

  // La duración cubre extracción, sondeos, cálculo y validación; la publicación queda afuera.
  const durationS = round3((deps.monotonicMs() - startedMs) / 1000);

  outcomes.report_collection_duration = isValidKpiValue('report_collection_duration', durationS)
    ? { value: durationS }
    : { reason: 'invalid-value' };

  const results: KpiResult[] = [];
  const omissions: KpiOmission[] = [];

  for (const { id, kind, unit } of KPI_CATALOG) {
    const outcome = outcomes[id] ?? { reason: 'not-collected' };

    if ('value' in outcome) {
      results.push({ kpi: id, kind, unit, value: outcome.value });
    } else {
      omissions.push({ kpi: id, reason: outcome.reason });
    }
  }

  return { cutoff: cutoff.toISOString(), localDate, results, omissions };
}
