import { loadFootballDataOrgEnv } from '../config/sports-provider-env.js';
import { agendaWindow } from '../modules/matches/domain/match-window.js';
import {
  formatCoverageProbe,
  formatPersistedWindow,
  hasCompetitionsList,
  isInconclusive,
  isWithinPlan,
  selectNationalTeamCompetitions,
  summarizeMatchesProbe,
  summarizePersistedWindow,
  type CompetitionProbeRow,
} from '../modules/matches/application/football-data-org-coverage-probe.js';
import { createFootballDataOrgClient } from '../modules/matches/infrastructure/football-data-org-client.js';

/**
 * Sondeo de solo lectura: ¿qué torneos de selecciones puede leer la cuenta de football-data.org
 * y devuelven partidos en la ventana? No escribe en la base ni usa Supabase. Hace un pedido a
 * `/v4/competitions` y uno por cada torneo de selecciones que el plan de la cuenta alcanza (el
 * límite del plan Free es de 10 por minuto, así que no necesita esperas).
 *
 * El informe no incluye la clave ni los encabezados del proveedor: se puede pegar en un ticket.
 *
 * Variables opcionales: `PROBE_ACCOUNT_PLAN` (por defecto `TIER_ONE`, el plan Free),
 * `PROBE_DATE_FROM` y `PROBE_DATE_TO` (`YYYY-MM-DD`, por defecto hoy y los 7 días siguientes).
 *
 * `PROBE_PERSISTED=true` agrega los partidos persistidos en la ventana de la agenda, con la misma
 * consulta que usa la API, para contrastarlos con lo que devuelve el proveedor. Lee la base que
 * apuntan `SUPABASE_URL` y la service_role key, así que exige confirmarla: `PROBE_ENV_LABEL` y
 * `PROBE_EXPECTED_SUPABASE_HOST` (el host que se espera en `SUPABASE_URL`). Solo lectura.
 *
 * Códigos de salida: 0 informe completo (aunque no haya cobertura), 1 el proveedor no respondió,
 * respondió algo que no se puede leer o alguna consulta quedó sin conclusión (un informe así no
 * prueba falta de cobertura), 2 configuración inválida.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PROBES = 8;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readDate(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} tiene que ser una fecha YYYY-MM-DD.`);
  }

  return value;
}

async function main(): Promise<void> {
  let env: ReturnType<typeof loadFootballDataOrgEnv>;
  let dateFrom: string;
  let dateTo: string;

  try {
    env = loadFootballDataOrgEnv();
    const today = new Date();
    dateFrom = readDate('PROBE_DATE_FROM', day(today));
    dateTo = readDate('PROBE_DATE_TO', day(new Date(today.getTime() + 7 * DAY_MS)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuración inválida.');
    process.exitCode = 2;
    return;
  }

  const accountPlan = process.env.PROBE_ACCOUNT_PLAN?.trim() || 'TIER_ONE';

  let competitionsBody: unknown;

  try {
    const response = await fetch(new URL('/v4/competitions', env.FOOTBALL_DATA_ORG_BASE_URL), {
      headers: { 'X-Auth-Token': env.FOOTBALL_DATA_ORG_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`GET /v4/competitions respondió HTTP ${response.status}.`);
      process.exitCode = 1;
      return;
    }

    competitionsBody = await response.json();
  } catch {
    console.error(
      'No se pudo leer GET /v4/competitions (red, tiempo de espera o una respuesta que no es JSON).',
    );
    process.exitCode = 1;
    return;
  }

  if (!hasCompetitionsList(competitionsBody)) {
    // Un 200 sin la lista de competiciones no es «el proveedor no tiene torneos de selecciones».
    console.error(
      'GET /v4/competitions respondió 200 pero sin la lista de competiciones: respuesta inválida.',
    );
    process.exitCode = 1;
    return;
  }

  const client = createFootballDataOrgClient({
    fetchFn: fetch,
    baseUrl: env.FOOTBALL_DATA_ORG_BASE_URL,
    apiKey: env.FOOTBALL_DATA_ORG_API_KEY,
  });

  const rows: CompetitionProbeRow[] = [];
  let probes = 0;

  for (const competition of selectNationalTeamCompetitions(competitionsBody)) {
    const withinPlan = isWithinPlan(competition.plan, accountPlan);

    if (!withinPlan || probes >= MAX_PROBES) {
      rows.push({ competition, withinPlan, probe: null });
      continue;
    }

    probes += 1;
    const outcome = await client.fetchMatches({
      competitionCode: competition.code,
      dateFrom,
      dateTo,
    });
    rows.push({ competition, withinPlan, probe: summarizeMatchesProbe(outcome) });
  }

  const report = { accountPlan, dateFrom, dateTo, rows };

  console.log(formatCoverageProbe(report));

  if (isInconclusive(report)) {
    console.error(
      '\nAlguna consulta no se pudo leer (tiempo de espera, red o respuesta inválida): este informe NO prueba falta de cobertura.',
    );
    process.exitCode = 1;
  }

  if (process.env.PROBE_PERSISTED?.trim() === 'true') {
    await printPersistedWindow();
  }
}

async function printPersistedWindow(): Promise<void> {
  const missing = ['PROBE_ENV_LABEL', 'PROBE_EXPECTED_SUPABASE_HOST'].filter(
    (name) => !process.env[name]?.trim(),
  );

  if (missing.length > 0 || !process.env.SUPABASE_URL) {
    console.error(
      `\nPara leer los partidos persistidos faltan: ${[...missing, ...(process.env.SUPABASE_URL ? [] : ['SUPABASE_URL'])].join(', ')}.`,
    );
    process.exitCode = 2;
    return;
  }

  if (new URL(process.env.SUPABASE_URL).host !== process.env.PROBE_EXPECTED_SUPABASE_HOST!.trim()) {
    console.error(
      '\nSUPABASE_URL no coincide con PROBE_EXPECTED_SUPABASE_HOST: no se lee una base que no se confirmó.',
    );
    process.exitCode = 2;
    return;
  }

  // Recién acá se carga `config/env`, que exige las variables de la API.
  const { createSupabaseSportsDataClient } =
    await import('../modules/matches/infrastructure/supabase-sports-data-client.js');
  const { SupabaseMatchStore } =
    await import('../modules/matches/infrastructure/supabase-match-store.js');
  const now = new Date();
  const window = agendaWindow(now);
  const store = new SupabaseMatchStore(createSupabaseSportsDataClient());
  const matches = await store.list(window);

  console.log(`\nEntorno: ${process.env.PROBE_ENV_LABEL} · ${now.toISOString()}`);
  console.log(formatPersistedWindow(summarizePersistedWindow(window, matches)));
}

main().catch(() => {
  console.error('El sondeo se interrumpió con un error inesperado.');
  process.exitCode = 1;
});
