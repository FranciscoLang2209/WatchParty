import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  collectKpis,
  readReporterApiBaseUrl,
} from '../modules/reporting/application/collect-kpis.js';
import { runReport, RESULT_FILE } from '../modules/reporting/application/run-report.js';
import { isReporterEnv } from '../modules/reporting/domain/kpi-catalog.js';
import { withProbeAccessToken } from '../modules/reporting/infrastructure/probe-auth.js';
import { readCatalogMatchCount } from '../modules/reporting/infrastructure/catalog-match-count-source.js';

const DEFAULT_OUTPUT_DIR = 'reporter-output';

/**
 * Corre el colector una vez y deja en `REPORTER_OUTPUT_DIR` (por defecto
 * `reporter-output`) el JSON del lote, el corte T y el resultado con los motivos
 * de omisión. No publica nada y no escribe en la base.
 *
 * Códigos de salida: `0` con todos los KPIs; `1` si falta cualquier fuente o no
 * se pudo armar el lote (fallo visible; los archivos igual quedan escritos); `2`
 * si `REPORTER_ENV` no es `dev` ni `prod`.
 */
async function main(): Promise<void> {
  const env = process.env.REPORTER_ENV?.trim();

  if (!isReporterEnv(env)) {
    console.error('REPORTER_ENV debe ser "dev" o "prod".');
    process.exitCode = 2;
    return;
  }

  const run = await runReport({
    env,
    runId: randomUUID(),
    collect: () =>
      collectKpis({
        apiBaseUrl: readReporterApiBaseUrl(),
        readCatalogMatchCount: (cutoff) => readCatalogMatchCount(cutoff),
        withProbeToken: (use) => withProbeAccessToken(use),
        fetchFn: fetch,
        now: () => new Date(),
        monotonicMs: () => performance.now(),
      }),
  });

  const outputDir = resolve(process.env.REPORTER_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR);

  await mkdir(outputDir, { recursive: true });

  for (const [name, content] of Object.entries(run.files)) {
    await writeFile(join(outputDir, name), content, 'utf8');
  }

  // Resumen para el log: solo códigos fijos, igual que el archivo de resultado.
  const result = JSON.parse(run.files[RESULT_FILE]!) as {
    results: unknown[];
    omissions: { kpi_id: string; reason: string }[];
  };

  console.log(
    `Reporter ${env}: ${result.results.length} KPIs con valor, ${result.omissions.length} omitidos. Archivos en ${outputDir}.`,
  );

  for (const omission of result.omissions) {
    console.log(`- ${omission.kpi_id}: ${omission.reason}`);
  }

  process.exitCode = run.exitCode;
}

main().catch((error: unknown) => {
  // Solo el tipo de error: su mensaje podría traer host, usuario o credenciales.
  const kind = error instanceof Error ? error.name : 'Error desconocido';
  console.error(`El colector de KPIs se interrumpió con un error inesperado (${kind}).`);
  process.exitCode = 1;
});
