import {
  collectKpis,
  readReporterApiBaseUrl,
} from '../modules/reporting/application/collect-kpis.js';
import { readCatalogMatchCount } from '../modules/reporting/infrastructure/catalog-match-count-source.js';

/**
 * Corre el colector una vez e imprime el artefacto de resultados y motivos de
 * omisión como JSON por la salida estándar. No publica nada y no escribe en la
 * base. Un KPI omitido NO es un fallo del comando: queda en `omissions`.
 */
async function main(): Promise<void> {
  const artifact = await collectKpis({
    apiBaseUrl: readReporterApiBaseUrl(),
    readCatalogMatchCount: (cutoff) => readCatalogMatchCount(cutoff),
    fetchFn: fetch,
    now: () => new Date(),
    monotonicMs: () => performance.now(),
  });

  console.log(JSON.stringify(artifact, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido.';
  console.error('El colector de KPIs se interrumpió con un error inesperado:', message);
  process.exitCode = 1;
});
