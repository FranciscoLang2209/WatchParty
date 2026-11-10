import { randomUUID } from 'node:crypto';
import {
  loadFootballDataOrgEnv,
  loadSportsProviderEnv,
  resolveBackfillFrom,
  resolveSyncProvider,
  type SyncProviderName,
} from '../config/sports-provider-env.js';
import { createApiFootballClient } from '../modules/matches/infrastructure/api-football-client.js';
import { createFootballDataOrgClient } from '../modules/matches/infrastructure/football-data-org-client.js';
import { checkSyncEnv, syncEnvRequirements } from '../config/sync-preflight.js';
import { SupabaseMatchStore } from '../modules/matches/infrastructure/supabase-match-store.js';
import {
  syncFootballDataOrgCompetitions,
  syncMatches,
  type CompetitionSyncResult,
  type SyncMatchesSummary,
  type SyncRunDeps,
} from '../modules/matches/application/sync-matches.js';
import { DAILY_FOOTBALL_DATA_ORG_COMPETITIONS } from '../modules/matches/application/football-data-org-competitions.js';

/** Resultado común a ambos proveedores; `competiciones` solo lo informa football-data.org. */
interface ProviderRunResult {
  exitCode: 0 | 1 | 2;
  summary?: SyncMatchesSummary;
  competiciones?: CompetitionSyncResult[];
}

type ProviderRunner = (deps: SyncRunDeps) => Promise<ProviderRunResult>;

function printResult(result: ProviderRunResult): void {
  if (result.competiciones) {
    console.log(`Resultado por competición:\n${JSON.stringify(result.competiciones, null, 2)}`);
  }
  if (result.summary) {
    console.log(`Resumen de sincronización:\n${JSON.stringify(result.summary, null, 2)}`);
  }
}

/**
 * Arma el cliente de UN proveedor con la configuración de entorno que le
 * corresponde. Lanza si falta esa configuración: el comando termina con
 * código 2 sin consultar a ningún proveedor.
 */
function createProviderRunner(
  provider: SyncProviderName,
  backfillFrom: string | undefined,
): ProviderRunner {
  if (provider === 'api-football') {
    const env = loadSportsProviderEnv();
    const client = createApiFootballClient({
      fetchFn: fetch,
      baseUrl: env.API_FOOTBALL_BASE_URL,
      apiKey: env.API_FOOTBALL_KEY,
    });

    return (deps) => syncMatches({ ...deps, client });
  }

  const env = loadFootballDataOrgEnv();
  const client = createFootballDataOrgClient({
    fetchFn: fetch,
    baseUrl: env.FOOTBALL_DATA_ORG_BASE_URL,
    apiKey: env.FOOTBALL_DATA_ORG_API_KEY,
  });

  // WAT-284: una corrida recorre todas las competiciones del sync diario con
  // la misma ventana móvil. Las temporadas cerradas no se consultan acá: son
  // del histórico manual (`matches:import-batch`).
  return async (deps) => {
    const result = await syncFootballDataOrgCompetitions(
      { ...deps, client },
      DAILY_FOOTBALL_DATA_ORG_COMPETITIONS,
      { backfillFrom },
    );
    return {
      exitCode: result.exitCode,
      summary: result.total,
      competiciones: result.competiciones,
    };
  };
}

async function main(): Promise<void> {
  let runProvider: ProviderRunner;
  try {
    const provider = resolveSyncProvider();
    // Preflight (WAT-186): valida todo el entorno, Supabase incluido, antes de
    // consultar al proveedor o escribir en la base.
    const preflight = checkSyncEnv(process.env, syncEnvRequirements(provider));

    if (!preflight.ok) {
      throw new Error(preflight.message);
    }

    runProvider = createProviderRunner(provider, resolveBackfillFrom());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuración inválida.');
    process.exitCode = 2;
    return;
  }

  // Import dinámico: `config/env.ts` lanza al cargarse si falta una variable, y
  // eso debe pasar recién después del preflight para que el fallo salga con código 2.
  const { createSupabaseSportsDataClient } =
    await import('../modules/matches/infrastructure/supabase-sports-data-client.js');
  const store = new SupabaseMatchStore(createSupabaseSportsDataClient());
  const clock = {
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const owner = randomUUID();

  const result = await runProvider({ store, clock, owner });

  if (result.exitCode === 2) {
    console.error('No se pudo adquirir el lease de sincronización: ya hay una ejecución en curso.');
    process.exitCode = 2;
    return;
  }

  printResult(result);
  const failed = result.competiciones?.filter((c) => c.resultado !== 'ok') ?? [];
  if (failed.length > 0) {
    console.error(
      `Competiciones con fallos: ${failed
        .map((c) => `${c.competitionCode}:${c.season} (${c.resultado})`)
        .join(', ')}`,
    );
  }
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido.';
  console.error('El comando de sincronización se interrumpió con un error inesperado:', message);
  process.exitCode = 1;
});
