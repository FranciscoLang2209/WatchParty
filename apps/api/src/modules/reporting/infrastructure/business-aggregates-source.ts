import {
  CatalogMatchCountSourceError,
  createPgClient,
  readCatalogSourceConfig,
  type CatalogSqlClientFactory,
} from './catalog-match-count-source.js';

/**
 * KPIs de negocio con agregado SQL propio (WAT-220 y WAT-221). Cada uno es una
 * función `reporting.<kpi>(cutoff)` que devuelve una fila `(value, omission_reason)`.
 */
export const BUSINESS_AGGREGATES = [
  { kpi: 'rated_match_rate', unit: '%', max: 100 },
  { kpi: 'monthly_interactions_avg', unit: '{interaction}/{user}', max: Infinity },
] as const;

export type BusinessKpiId = (typeof BUSINESS_AGGREGATES)[number]['kpi'];

/**
 * Motivos por los que un KPI de negocio no tiene valor. Son los de la fuente
 * SQL de `catalog_match_count` (misma conexión, mismos significados) más
 * `no-denominator`: el agregado respondió, pero el mes no tiene base para
 * calcularlo. Ninguno se traduce a cero.
 */
export type BusinessAggregateFailureReason =
  | 'config-missing'
  | 'config-invalid'
  | 'invalid-cutoff'
  | 'connection-failed'
  | 'permission-denied'
  | 'query-failed'
  | 'invalid-result'
  | 'no-denominator';

export type BusinessAggregateOutcome =
  { ok: true; value: number; unit: string } | { ok: false; reason: BusinessAggregateFailureReason };

/** Un desenlace por KPI, todos calculados con el mismo corte T. */
export type BusinessAggregates = Record<BusinessKpiId, BusinessAggregateOutcome>;

export interface BusinessAggregatesDeps {
  env?: NodeJS.ProcessEnv;
  createClient?: CatalogSqlClientFactory;
  now?: () => Date;
}

function aggregateSql(kpi: BusinessKpiId): string {
  return `select value, omission_reason from reporting.${kpi}($1::timestamptz)`;
}

function allFailed(reason: BusinessAggregateFailureReason): BusinessAggregates {
  return Object.fromEntries(
    BUSINESS_AGGREGATES.map(({ kpi }) => [kpi, { ok: false, reason }]),
  ) as BusinessAggregates;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }

  return undefined;
}

// Mismo criterio que la fuente de `catalog_match_count`: 28xxx = autorización
// inválida y 42501 = privilegio insuficiente; el resto, el motivo de la etapa.
function classify<F extends 'connection-failed' | 'query-failed'>(
  error: unknown,
  fallback: F,
): 'permission-denied' | F {
  const code = sqlState(error);

  if (code !== undefined && (code === '42501' || /^28[0-9A-Z]{3}$/.test(code))) {
    return 'permission-denied';
  }

  return fallback;
}

/**
 * Interpreta la fila del agregado. Valor solo si es un número finito dentro
 * del dominio del KPI (porcentaje 0–100, promedio no negativo) y sin motivo.
 * Los motivos conocidos del agregado se propagan; cualquier otra forma (sin
 * filas, nulo sin motivo, texto, fuera de rango, motivo desconocido) es un
 * resultado inválido, nunca cero.
 */
function parseAggregate(
  rows: unknown[],
  aggregate: (typeof BUSINESS_AGGREGATES)[number],
): BusinessAggregateOutcome {
  const row: unknown = rows.length === 1 ? rows[0] : undefined;

  if (typeof row !== 'object' || row === null || !('value' in row) || !('omission_reason' in row)) {
    return { ok: false, reason: 'invalid-result' };
  }

  const { value, omission_reason: reason } = row;

  if (reason !== null) {
    if (value === null && (reason === 'no-denominator' || reason === 'invalid-cutoff')) {
      return { ok: false, reason };
    }

    return { ok: false, reason: 'invalid-result' };
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > aggregate.max) {
    return { ok: false, reason: 'invalid-result' };
  }

  return { ok: true, value, unit: aggregate.unit };
}

/**
 * Lee `rated_match_rate` y `monthly_interactions_avg` al corte `cutoff` con
 * el usuario restringido del reporter: la misma configuración, el mismo TLS
 * verificado y una sola conexión que la fuente de `catalog_match_count`. El
 * rol solo ejecuta los agregados autorizados; nunca lee tablas.
 *
 * No lanza: devuelve un desenlace por KPI. Un fallo de configuración, de
 * conexión o de corte omite ambos con el mismo motivo; un fallo de consulta o
 * de resultado omite solo ese KPI. Los motivos son códigos fijos, sin texto
 * del driver, de Postgres ni de la URL.
 */
export async function readBusinessAggregates(
  cutoff: Date,
  deps: BusinessAggregatesDeps = {},
): Promise<BusinessAggregates> {
  const { env = process.env, createClient = createPgClient, now = () => new Date() } = deps;

  let config;

  try {
    config = readCatalogSourceConfig(env);
  } catch (error) {
    return allFailed(
      error instanceof CatalogMatchCountSourceError && error.reason === 'config-missing'
        ? 'config-missing'
        : 'config-invalid',
    );
  }

  const cutoffMs = cutoff.getTime();

  if (!Number.isFinite(cutoffMs) || cutoffMs > now().getTime()) {
    return allFailed('invalid-cutoff');
  }

  const client = createClient(config);

  try {
    try {
      await client.connect();
    } catch (error) {
      return allFailed(classify(error, 'connection-failed'));
    }

    const cutoffIso = cutoff.toISOString();
    const outcomes: Partial<BusinessAggregates> = {};

    for (const aggregate of BUSINESS_AGGREGATES) {
      try {
        const { rows } = await client.query(aggregateSql(aggregate.kpi), [cutoffIso]);
        outcomes[aggregate.kpi] = parseAggregate(rows, aggregate);
      } catch (error) {
        outcomes[aggregate.kpi] = { ok: false, reason: classify(error, 'query-failed') };
      }
    }

    return outcomes as BusinessAggregates;
  } finally {
    try {
      await client.end();
    } catch {
      // Cerrar es best-effort: no debe tapar los resultados ni los motivos.
    }
  }
}

/** Tablas con datos personales que alimentan los agregados de negocio. */
export const PERSONAL_DATA_TABLES = [
  'public.watched_matches',
  'public.match_ratings',
  'public.room_comments',
  'reporting.technical_accounts',
] as const;

export type PersonalDataTable = (typeof PERSONAL_DATA_TABLES)[number];

/**
 * `denied`: Postgres rechazó la lectura por permisos (lo esperado). `readable`:
 * la lectura funcionó, el rol del reporter tiene más permisos de los debidos.
 * Cualquier otro código: no se pudo comprobar (`login-rejected` = el login del
 * reporter fue rechazado, no la lectura).
 */
export type DirectReadOutcome =
  | 'denied'
  | 'readable'
  | 'config-missing'
  | 'config-invalid'
  | 'connection-failed'
  | 'login-rejected'
  | 'query-failed';

/**
 * Comprueba con la misma credencial del reporter que no puede leer filas
 * personales directamente. Solo intenta `select 1 ... limit 1`: no trae datos,
 * y el resultado son códigos fijos.
 */
export async function checkDirectReadsDenied(
  deps: Omit<BusinessAggregatesDeps, 'now'> = {},
): Promise<Record<PersonalDataTable, DirectReadOutcome>> {
  const { env = process.env, createClient = createPgClient } = deps;

  const all = (outcome: DirectReadOutcome) =>
    Object.fromEntries(PERSONAL_DATA_TABLES.map((table) => [table, outcome])) as Record<
      PersonalDataTable,
      DirectReadOutcome
    >;

  let config;

  try {
    config = readCatalogSourceConfig(env);
  } catch (error) {
    return all(
      error instanceof CatalogMatchCountSourceError && error.reason === 'config-missing'
        ? 'config-missing'
        : 'config-invalid',
    );
  }

  const client = createClient(config);

  try {
    try {
      await client.connect();
    } catch (error) {
      const reason = classify(error, 'connection-failed');
      return all(reason === 'permission-denied' ? 'login-rejected' : reason);
    }

    const outcomes: Partial<Record<PersonalDataTable, DirectReadOutcome>> = {};

    for (const table of PERSONAL_DATA_TABLES) {
      try {
        await client.query(`select 1 from ${table} limit 1`, []);
        outcomes[table] = 'readable';
      } catch (error) {
        outcomes[table] = sqlState(error) === '42501' ? 'denied' : 'query-failed';
      }
    }

    return outcomes as Record<PersonalDataTable, DirectReadOutcome>;
  } finally {
    try {
      await client.end();
    } catch {
      // Best-effort, igual que en readBusinessAggregates.
    }
  }
}
