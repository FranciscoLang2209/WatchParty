import { appendFileSync } from 'node:fs';
import { loadSportsProviderEnv } from '../config/sports-provider-env.js';
import { checkSyncEnv, syncEnvRequirements } from '../config/sync-preflight.js';
import { createApiFootballClient } from '../modules/matches/infrastructure/api-football-client.js';
import { SupabaseProviderQuotaStore } from '../modules/matches/infrastructure/supabase-provider-quota-store.js';
import {
  enrichMatchesBatch,
  formatEnrichBatchEvidence,
  formatEnrichBatchTable,
} from '../modules/match-enrichment/application/enrich-matches-batch.js';
import {
  parseEnrichmentManifest,
  type EnrichmentEntry,
} from '../modules/match-enrichment/application/enrichment-manifest.js';
import { SupabaseMatchEnrichmentStore } from '../modules/match-enrichment/infrastructure/supabase-match-enrichment-store.js';

/**
 * Enriquecimiento histórico por lote (estadísticas y goles de API-Football) sobre partidos YA
 * guardados. Nunca crea partidos ni equipos y no usa el importador de fixtures.
 *
 * Entradas (variables de entorno, sin interpolar nada en un shell):
 *  - ENRICHMENT_BATCH: pares `matchId:fixtureId` aprobados. Obligatorio.
 *  - ENRICHMENT_DRY_RUN: `true` (por defecto) o `false`. Con `true` hace las consultas, que
 *    consumen cuota, y reporta qué guardaría sin escribir estadísticas ni eventos.
 *
 * Códigos de salida: 0 todo bien, 1 algún partido falló o fue rechazado (o cambió la cantidad de
 * partidos), 2 configuración inválida (no se consultó ni se escribió nada).
 */

/** Solo `true` o `false`: un valor raro nunca se interpreta como «escribir». Vacío = `true`. */
function parseDryRun(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? '';

  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(`ENRICHMENT_DRY_RUN inválido: debe ser "true" o "false".`);
}

async function main(): Promise<void> {
  let entries: EnrichmentEntry[];
  let dryRun: boolean;
  let providerEnv: ReturnType<typeof loadSportsProviderEnv>;

  try {
    // Las credenciales se validan ANTES de consultar o escribir; los mensajes nunca traen valores.
    const preflight = checkSyncEnv(process.env, syncEnvRequirements('api-football'));
    if (!preflight.ok) throw new Error(preflight.message);

    dryRun = parseDryRun(process.env.ENRICHMENT_DRY_RUN);
    entries = parseEnrichmentManifest(process.env.ENRICHMENT_BATCH ?? '');
    providerEnv = loadSportsProviderEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuración inválida.');
    process.exitCode = 2;
    return;
  }

  const { createSupabaseSportsDataClient } =
    await import('../modules/matches/infrastructure/supabase-sports-data-client.js');
  const supabase = createSupabaseSportsDataClient();

  const client = createApiFootballClient({
    fetchFn: fetch,
    baseUrl: providerEnv.API_FOOTBALL_BASE_URL,
    apiKey: providerEnv.API_FOOTBALL_KEY,
  });
  const clock = {
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

  console.log(
    `Modo: ${dryRun ? 'dry_run (no se escribe nada; las consultas sí consumen cuota)' : 'escritura'}`,
  );
  console.log(`Lote: ${entries.length} correspondencia(s)`);

  const report = await enrichMatchesBatch(
    {
      client,
      store: new SupabaseMatchEnrichmentStore(supabase),
      quota: new SupabaseProviderQuotaStore(supabase),
      clock,
    },
    entries,
    { dryRun },
  );

  const table = formatEnrichBatchTable(report);
  console.log(`Reporte de enriquecimiento:\n${JSON.stringify(report, null, 2)}`);
  console.log(`\n${table}`);

  // En GitHub Actions el resumen queda visible en la página de la ejecución.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      `## Enriquecimiento de partidos históricos\n\n${table}\n\n## Evidencia por partido\n\n${formatEnrichBatchEvidence(report)}\n`,
    );
  }

  process.exitCode = report.exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido.';
  console.error('El enriquecimiento se interrumpió con un error inesperado:', message);
  process.exitCode = 1;
});
