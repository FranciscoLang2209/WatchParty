import type { ReporterEnv } from '../domain/kpi-catalog.js';
import {
  OMISSION_REASONS,
  UNKNOWN_OMISSION_REASON,
  buildMeasurementBatch,
  serializeArchive,
  serializeBatchPayload,
  type BatchIssue,
  type KpiOmission,
} from '../domain/measurement-batch.js';
import type { CollectionArtifact } from './collect-kpis.js';

/** JSON del lote que se enviaría a la plataforma central: solo las filas del contrato. */
export const PAYLOAD_FILE = 'payload.json';
/** Corte T, lote y motivos de omisión de la corrida (`serializeArchive`, WAT-200). */
export const ARCHIVE_FILE = 'archive.json';
/** Resultado de la corrida y motivos, presente aunque no se pueda armar un lote. */
export const RESULT_FILE = 'result.json';

export interface RunReportInput {
  env: ReporterEnv;
  /** UUID común de la corrida. */
  runId: string;
  collect: () => Promise<CollectionArtifact>;
}

export interface ReportRun {
  /** Nombre de archivo → contenido. `result.json` está siempre; los otros solo si hay lote. */
  files: Record<string, string>;
  /**
   * `0` solo con todos los KPIs del catálogo. `1` si falta cualquier fuente o no se pudo
   * armar el lote: una fuente omitida es un fallo VISIBLE, no un éxito parcial.
   */
  exitCode: 0 | 1;
}

function sanitizedOmissions(artifact: CollectionArtifact): KpiOmission[] {
  return artifact.omissions.map(({ kpi, reason }) => ({
    kpi_id: kpi,
    reason: (OMISSION_REASONS as readonly string[]).includes(reason)
      ? (reason as KpiOmission['reason'])
      : UNKNOWN_OMISSION_REASON,
  }));
}

/**
 * Colecta los KPIs, arma el lote y deja listos los artefactos de la corrida. No
 * publica nada: no hay ningún envío a la plataforma central en este flujo, y
 * `published` queda en `false`. Los archivos solo contienen códigos fijos,
 * números, el `run_id` y el ambiente: ninguna clave, URL ni texto de error.
 */
export async function runReport({ env, runId, collect }: RunReportInput): Promise<ReportRun> {
  const artifact = await collect();

  const built = buildMeasurementBatch({
    env,
    cutoff: new Date(artifact.cutoff),
    runId,
    results: artifact.results,
    omissions: artifact.omissions,
  });

  const files: Record<string, string> = {};
  let issues: BatchIssue[] = built.ok ? [] : built.issues;

  if (built.ok) {
    const payload = serializeBatchPayload(built.batch.rows);
    const archive = serializeArchive(built.batch);

    if (payload.ok && archive.ok) {
      files[PAYLOAD_FILE] = payload.json;
      files[ARCHIVE_FILE] = archive.json;
    } else {
      issues = [...(payload.ok ? [] : payload.issues), ...(archive.ok ? [] : archive.issues)];
    }
  }

  const complete = built.ok && built.batch.complete && issues.length === 0;

  files[RESULT_FILE] = JSON.stringify(
    {
      env,
      run_id: runId,
      cutoff: artifact.cutoff,
      local_date: artifact.localDate,
      ok: complete,
      complete,
      visible_failure: !complete,
      results: artifact.results,
      omissions: built.ok ? built.batch.omissions : sanitizedOmissions(artifact),
      issues,
      published: false,
    },
    null,
    2,
  );

  return { files, exitCode: complete ? 0 : 1 };
}
