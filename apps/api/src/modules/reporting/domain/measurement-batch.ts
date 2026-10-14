import {
  KPI_CATALOG,
  isKpiId,
  isReporterEnv,
  isValidKpiValue,
  type KpiId,
  type ReporterEnv,
} from './kpi-catalog.js';

/** Zona horaria con la que se calcula `date`. */
const LOCAL_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** El contrato central acepta de 1 a 10 mediciones por envío. */
export const MAX_BATCH_ROWS = 10;

/**
 * Fila del contrato central. Son los ÚNICOS campos que viajan: el servidor
 * asigna `project_id` y `reported_at`, y no se envían `team_id`, `status` ni
 * `measured_at`.
 */
export interface MeasurementRow {
  kpi_id: KpiId;
  date: string;
  env: ReporterEnv;
  value: number;
  run_id: string;
}

const ROW_KEYS = ['kpi_id', 'date', 'env', 'value', 'run_id'] as const;

// Campos que el servidor asigna o que el contrato prohíbe enviar.
const FORBIDDEN_FIELDS = ['project_id', 'reported_at', 'team_id', 'status', 'measured_at'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type BatchIssueCode =
  | 'invalid-env'
  | 'invalid-cutoff'
  | 'invalid-run-id'
  | 'invalid-date'
  | 'invalid-value'
  | 'unknown-kpi'
  | 'duplicate-kpi'
  | 'not-an-array'
  | 'not-an-object'
  | 'empty-batch'
  | 'too-many-rows'
  | 'missing-field'
  | 'forbidden-field'
  | 'unexpected-field'
  | 'run-id-mismatch'
  | 'env-mismatch'
  | 'date-mismatch';

/** Un problema del lote. Nunca incluye valores, solo dónde está y de qué tipo es. */
export interface BatchIssue {
  /** Índice de la fila, o `null` si afecta a todo el lote. */
  row: number | null;
  code: BatchIssueCode;
  field?: string;
}

export interface KpiOmission {
  kpi_id: KpiId;
  /** Motivo fijo y sanitizado. */
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const match = DATE_PATTERN.exec(value);

  if (!match) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Fecha local de Argentina del corte T (`YYYY-MM-DD`). Es el `date` de todas
 * las filas del lote. Lanza si `cutoff` no es una fecha válida.
 */
export function toArgentinaDate(cutoff: Date): string {
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error('El corte T no es una fecha válida.');
  }

  // `en-CA` formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(cutoff);
}

export type ValidationResult =
  { ok: true; rows: MeasurementRow[] } | { ok: false; issues: BatchIssue[] };

/**
 * Valida un lote ya armado (por ejemplo, el JSON que se va a enviar). Es todo o
 * nada: una sola fila inválida invalida el lote entero y no se devuelven filas.
 * Exige filas con exactamente los cinco campos del contrato, KPIs del catálogo
 * sin repetir, valores válidos y `run_id`, `env` y `date` comunes.
 */
export function validateMeasurementBatch(input: unknown): ValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, issues: [{ row: null, code: 'not-an-array' }] };
  }

  if (input.length === 0) {
    return { ok: false, issues: [{ row: null, code: 'empty-batch' }] };
  }

  if (input.length > MAX_BATCH_ROWS) {
    return { ok: false, issues: [{ row: null, code: 'too-many-rows' }] };
  }

  const issues: BatchIssue[] = [];
  const rows: MeasurementRow[] = [];
  const seenKpis = new Set<string>();
  const runIds = new Set<unknown>();
  const envs = new Set<unknown>();
  const dates = new Set<unknown>();

  input.forEach((candidate: unknown, row) => {
    if (!isPlainObject(candidate)) {
      issues.push({ row, code: 'not-an-object' });
      return;
    }

    for (const key of Object.keys(candidate)) {
      if ((ROW_KEYS as readonly string[]).includes(key)) continue;

      if ((FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
        issues.push({ row, code: 'forbidden-field', field: key });
      } else {
        issues.push({ row, code: 'unexpected-field' });
      }
    }

    for (const key of ROW_KEYS) {
      if (!Object.hasOwn(candidate, key)) issues.push({ row, code: 'missing-field', field: key });
    }

    const { kpi_id: kpiId, date, env, value, run_id: runId } = candidate;

    if (Object.hasOwn(candidate, 'kpi_id')) {
      if (!isKpiId(kpiId)) {
        issues.push({ row, code: 'unknown-kpi' });
      } else if (seenKpis.has(kpiId)) {
        issues.push({ row, code: 'duplicate-kpi' });
      } else {
        seenKpis.add(kpiId);
      }
    }

    if (Object.hasOwn(candidate, 'date') && !isRealDate(date)) {
      issues.push({ row, code: 'invalid-date' });
    }

    if (Object.hasOwn(candidate, 'env') && !isReporterEnv(env)) {
      issues.push({ row, code: 'invalid-env' });
    }

    if (
      Object.hasOwn(candidate, 'run_id') &&
      !(typeof runId === 'string' && UUID_PATTERN.test(runId))
    ) {
      issues.push({ row, code: 'invalid-run-id' });
    }

    if (Object.hasOwn(candidate, 'value')) {
      const valid = isKpiId(kpiId)
        ? isValidKpiValue(kpiId, value)
        : typeof value === 'number' && Number.isFinite(value);

      if (!valid) issues.push({ row, code: 'invalid-value' });
    }

    runIds.add(runId);
    envs.add(env);
    dates.add(date);
  });

  if (runIds.size > 1) issues.push({ row: null, code: 'run-id-mismatch' });
  if (envs.size > 1) issues.push({ row: null, code: 'env-mismatch' });
  if (dates.size > 1) issues.push({ row: null, code: 'date-mismatch' });

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  for (const candidate of input as Record<string, unknown>[]) {
    // Se copian solo los cinco campos, en orden fijo.
    rows.push({
      kpi_id: candidate.kpi_id as KpiId,
      date: candidate.date as string,
      env: candidate.env as ReporterEnv,
      value: candidate.value as number,
      run_id: candidate.run_id as string,
    });
  }

  return { ok: true, rows };
}

export interface BuildBatchInput {
  env: ReporterEnv;
  /** Corte T. De su fecha local de Argentina sale el `date` de todas las filas. */
  cutoff: Date;
  /** UUID común de la corrida. */
  runId: string;
  /** KPIs con valor calculado. El valor se valida acá: no se asume correcto. */
  results: readonly { kpi: string; value: unknown }[];
  /** KPIs sin fuente válida, con su motivo. */
  omissions: readonly { kpi: string; reason: string }[];
  /** `true` para identificar el artefacto como simulado (pruebas). */
  simulated?: boolean;
}

/** Lote listo para enviar más el registro de la corrida que se archiva. */
export interface ReportBatch {
  /** Corte T en ISO 8601 UTC. */
  cutoff: string;
  date: string;
  env: ReporterEnv;
  run_id: string;
  /** Mediciones a enviar: solo los cinco campos del contrato. */
  rows: MeasurementRow[];
  /** KPIs omitidos con su motivo. Nunca se envían como null ni como cero. */
  omissions: KpiOmission[];
  /** `true` solo si están los cinco KPIs. Con menos, el día no está completo. */
  complete: boolean;
  /** `true` si se omitió algún KPI: el workflow debe marcar el fallo de forma visible. */
  visible_failure: boolean;
  simulated: boolean;
}

export type BuildResult =
  { ok: true; batch: ReportBatch } | { ok: false; issues: BatchIssue[]; omissions: KpiOmission[] };

/**
 * Arma el lote de una corrida a partir de lo que dejó el colector.
 *
 * - Fuente inválida (sin valor, NaN, infinito, null, fuera de rango): el KPI se
 *   omite con su motivo; nunca se envía null ni se inventa un cero.
 * - Lote inválido (ambiente, corte o UUID inválidos, KPI fuera del catálogo o
 *   repetido, nada que enviar): no se arma ningún lote.
 */
export function buildMeasurementBatch(input: BuildBatchInput): BuildResult {
  const issues: BatchIssue[] = [];

  if (!isReporterEnv(input.env)) issues.push({ row: null, code: 'invalid-env' });
  if (!(input.cutoff instanceof Date) || !Number.isFinite(input.cutoff.getTime())) {
    issues.push({ row: null, code: 'invalid-cutoff' });
  }
  if (typeof input.runId !== 'string' || !UUID_PATTERN.test(input.runId)) {
    issues.push({ row: null, code: 'invalid-run-id' });
  }

  const resultByKpi = new Map<KpiId, unknown>();
  const reasonByKpi = new Map<KpiId, string>();

  for (const result of input.results) {
    if (!isKpiId(result.kpi)) {
      issues.push({ row: null, code: 'unknown-kpi' });
    } else if (resultByKpi.has(result.kpi)) {
      issues.push({ row: null, code: 'duplicate-kpi' });
    } else {
      resultByKpi.set(result.kpi, result.value);
    }
  }

  for (const omission of input.omissions) {
    if (!isKpiId(omission.kpi)) {
      issues.push({ row: null, code: 'unknown-kpi' });
    } else if (reasonByKpi.has(omission.kpi) || resultByKpi.has(omission.kpi)) {
      // Repetido, o con valor y omitido a la vez: la fuente es ambigua.
      issues.push({ row: null, code: 'duplicate-kpi' });
    } else {
      reasonByKpi.set(omission.kpi, omission.reason);
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, omissions: [] };
  }

  const date = toArgentinaDate(input.cutoff);
  const rows: MeasurementRow[] = [];
  const omissions: KpiOmission[] = [];

  for (const { id } of KPI_CATALOG) {
    if (resultByKpi.has(id)) {
      const value = resultByKpi.get(id);

      if (isValidKpiValue(id, value)) {
        rows.push({ kpi_id: id, date, env: input.env, value, run_id: input.runId });
      } else {
        omissions.push({ kpi_id: id, reason: 'invalid-value' });
      }
    } else {
      omissions.push({ kpi_id: id, reason: reasonByKpi.get(id) ?? 'not-collected' });
    }
  }

  if (rows.length === 0) {
    return { ok: false, issues: [{ row: null, code: 'empty-batch' }], omissions };
  }

  // Defensa en profundidad: el lote armado pasa por el mismo validador que el que se envía.
  const validation = validateMeasurementBatch(rows);

  if (!validation.ok) {
    return { ok: false, issues: validation.issues, omissions };
  }

  return {
    ok: true,
    batch: {
      cutoff: input.cutoff.toISOString(),
      date,
      env: input.env,
      run_id: input.runId,
      rows: validation.rows,
      omissions,
      complete: rows.length === KPI_CATALOG.length,
      visible_failure: omissions.length > 0,
      simulated: input.simulated ?? false,
    },
  };
}

/** Cuerpo exacto a enviar: solo las filas del contrato. */
export function serializeBatchPayload(rows: readonly MeasurementRow[]): string {
  return JSON.stringify(rows);
}

/** Registro archivable de la corrida (JSON y corte, sin secretos). */
export function serializeArchive(batch: ReportBatch): string {
  return JSON.stringify(batch, null, 2);
}
