import { randomUUID } from 'node:crypto';
import {
  loadFootballDataOrgEnv,
  loadSportsProviderEnv,
  resolveSyncProvider,
  type SyncProviderName,
} from '../config/sports-provider-env.js';
import { createApiFootballClient } from '../modules/matches/infrastructure/api-football-client.js';
import { createFootballDataOrgClient } from '../modules/matches/infrastructure/football-data-org-client.js';
import { createSupabaseSportsDataClient } from '../modules/matches/infrastructure/supabase-sports-data-client.js';
import { SupabaseMatchStore } from '../modules/matches/infrastructure/supabase-match-store.js';
import {
  syncFootballDataOrgMatches,
  syncMatches,
  type SyncMatchesResult,
  type SyncMatchesSummary,
  type SyncRunDeps,
} from '../modules/matches/application/sync-matches.js';

type ProviderRunner = (deps: SyncRunDeps) => Promise<SyncMatchesResult>;

function printSummary(summary: SyncMatchesSummary): void {
  console.log(`Resumen de sincronización:\n${JSON.stringify(summary, null, 2)}`);
}

/**
 * Arma el cliente de UN proveedor con la configuración de entorno que le
 * corresponde. Lanza si falta esa configuración: el comando termina con
 * código 2 sin consultar a ningún proveedor.
 */
function createProviderRunner(provider: SyncProviderName): ProviderRunner {
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

  return (deps) => syncFootballDataOrgMatches({ ...deps, client });
}

async function main(): Promise<void> {
  let runProvider: ProviderRunner;
  try {
    runProvider = createProviderRunner(resolveSyncProvider());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuración inválida.');
    process.exitCode = 2;
    return;
  }

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

  printSummary(result.summary);
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido.';
  console.error('El comando de sincronización se interrumpió con un error inesperado:', message);
  process.exitCode = 1;
});
