import { randomUUID } from 'node:crypto';
import { loadFootballDataOrgEnv } from '../config/sports-provider-env.js';
import { checkSyncEnv, syncEnvRequirements } from '../config/sync-preflight.js';
import { createFootballDataOrgClient } from '../modules/matches/infrastructure/football-data-org-client.js';
import { SupabaseMatchStore } from '../modules/matches/infrastructure/supabase-match-store.js';
import {
  DEFAULT_IMPORT_BATCH,
  formatImportBatchTable,
  importMatchesBatch,
  parseImportBatch,
  type ImportBatchEntry,
} from '../modules/matches/application/import-matches-batch.js';

/**
 * Importación manual por lotes de football-data.org (piloto del Tercer
 * Steering). El lote se pasa en `MATCHES_IMPORT_BATCH` como `CODIGO:AÑO`
 * separado por comas; sin valor usa el lote del piloto. No toca el
 * sincronizador diario (`matches:sync`).
 *
 * Códigos de salida: 0 todas las entradas ok, 1 alguna falló o fue rechazada,
 * 2 configuración inválida.
 */
async function main(): Promise<void> {
  let entries: ImportBatchEntry[];
  let env: ReturnType<typeof loadFootballDataOrgEnv>;
  try {
    const preflight = checkSyncEnv(process.env, syncEnvRequirements('football-data-org'));
    if (!preflight.ok) {
      throw new Error(preflight.message);
    }
    entries = parseImportBatch(process.env.MATCHES_IMPORT_BATCH?.trim() || DEFAULT_IMPORT_BATCH);
    env = loadFootballDataOrgEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuración inválida.');
    process.exitCode = 2;
    return;
  }

  const { createSupabaseSportsDataClient } =
    await import('../modules/matches/infrastructure/supabase-sports-data-client.js');
  const store = new SupabaseMatchStore(createSupabaseSportsDataClient());
  const client = createFootballDataOrgClient({
    fetchFn: fetch,
    baseUrl: env.FOOTBALL_DATA_ORG_BASE_URL,
    apiKey: env.FOOTBALL_DATA_ORG_API_KEY,
  });
  const clock = {
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

  console.log(`Lote: ${entries.map((e) => `${e.competitionCode}:${e.season}`).join(', ')}`);
  const report = await importMatchesBatch({ client, store, clock, owner: randomUUID() }, entries);

  console.log(`Reporte de importación:\n${JSON.stringify(report, null, 2)}`);
  console.log(`\n${formatImportBatchTable(report)}`);
  process.exitCode = report.exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido.';
  console.error('La importación por lotes se interrumpió con un error inesperado:', message);
  process.exitCode = 1;
});
