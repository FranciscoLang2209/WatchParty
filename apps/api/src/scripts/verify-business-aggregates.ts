import {
  checkDirectReadsDenied,
  readBusinessAggregates,
} from '../modules/reporting/infrastructure/business-aggregates-source.js';

const CLOCK_SKEW_MARGIN_MS = 5_000;

/**
 * Lectura real saneada de los agregados de negocio (WAT-222) con la credencial
 * del reporter (`REPORTER_DATABASE_URL`): ejecuta `rated_match_rate` y
 * `monthly_interactions_avg` con un mismo corte T y comprueba que ese rol no
 * puede leer filas personales. Solo imprime códigos y números agregados.
 *
 * Código de salida `0` si ambos agregados respondieron (valor u omisión por
 * denominador) y todas las lecturas directas fueron denegadas; `1` si no.
 */
async function main(): Promise<void> {
  // Unos segundos antes de ahora: si el reloj local va adelantado respecto
  // al de la base, el agregado vería el corte como futuro ('invalid-cutoff').
  const cutoff = new Date(Date.now() - CLOCK_SKEW_MARGIN_MS);
  const aggregates = await readBusinessAggregates(cutoff);
  const directReads = await checkDirectReadsDenied();

  console.log(`Corte T: ${cutoff.toISOString()}`);

  let ok = true;

  for (const [kpi, outcome] of Object.entries(aggregates)) {
    if (outcome.ok) {
      console.log(`[OK] ${kpi}: ${outcome.value} ${outcome.unit}`);
    } else {
      const answered = outcome.reason === 'no-denominator';
      ok &&= answered;
      console.log(`[${answered ? 'OK' : 'FALLÓ'}] ${kpi}: omitido (${outcome.reason})`);
    }
  }

  for (const [table, outcome] of Object.entries(directReads)) {
    const denied = outcome === 'denied';
    ok &&= denied;
    console.log(`[${denied ? 'OK' : 'FALLÓ'}] lectura directa de ${table}: ${outcome}`);
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((error: unknown) => {
  // Solo el tipo de error: su mensaje podría traer host, usuario o credenciales.
  const kind = error instanceof Error ? error.name : 'Error desconocido';
  console.error(`La verificación se interrumpió con un error inesperado (${kind}).`);
  process.exitCode = 1;
});
