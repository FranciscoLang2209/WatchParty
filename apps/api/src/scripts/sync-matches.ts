import { randomUUID } from 'node:crypto';
import { loadSportsProviderEnv, type SportsProviderEnv } from '../config/sports-provider-env.js';
import { createApiFootballClient } from '../modules/matches/infrastructure/api-football-client.js';
import { createSupabaseSportsDataClient } from '../modules/matches/infrastructure/supabase-sports-data-client.js';
import { SupabaseMatchStore } from '../modules/matches/infrastructure/supabase-match-store.js';
import {
  syncMatches,
  type SyncMatchesSummary,
} from '../modules/matches/application/sync-matches.js';

function printSummary(summary: SyncMatchesSummary): void {
  console.log(`Resumen de sincronización:\n${JSON.stringify(summary, null, 2)}`);
}

async function main(): Promise<void> {
  let sportsEnv: SportsProviderEnv;
  try {
    sportsEnv = loadSportsProviderEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuración inválida.');
    process.exitCode = 2;
    return;
  }

  const client = createApiFootballClient({
    fetchFn: fetch,
    baseUrl: sportsEnv.API_FOOTBALL_BASE_URL,
    apiKey: sportsEnv.API_FOOTBALL_KEY,
  });
  const store = new SupabaseMatchStore(createSupabaseSportsDataClient());
  const clock = {
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const owner = randomUUID();

  const result = await syncMatches({ client, store, clock, owner });

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
