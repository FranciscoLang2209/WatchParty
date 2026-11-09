export interface SportsProviderEnv {
  API_FOOTBALL_BASE_URL: string;
  API_FOOTBALL_KEY: string;
}

export interface FootballDataOrgEnv {
  FOOTBALL_DATA_ORG_BASE_URL: string;
  FOOTBALL_DATA_ORG_API_KEY: string;
}

/** Proveedores que `matches:sync` sabe usar. Una corrida usa uno solo. */
export type SyncProviderName = 'football-data-org' | 'api-football';

/** El que importa fixtures actuales (WAT-182). API-Football queda como opción explícita. */
export const DEFAULT_SYNC_PROVIDER: SyncProviderName = 'football-data-org';

const SYNC_PROVIDERS: readonly SyncProviderName[] = ['football-data-org', 'api-football'];

const REQUIRED_SPORTS_PROVIDER_ENV_VARS = ['API_FOOTBALL_BASE_URL', 'API_FOOTBALL_KEY'] as const;

const REQUIRED_FOOTBALL_DATA_ORG_ENV_VARS = [
  'FOOTBALL_DATA_ORG_BASE_URL',
  'FOOTBALL_DATA_ORG_API_KEY',
] as const;

function requireEnvVars<Name extends string>(
  names: readonly Name[],
  env: NodeJS.ProcessEnv,
): Record<Name, string> {
  const values = {} as Record<Name, string>;

  for (const name of names) {
    const value = env[name]?.trim();

    if (!value) {
      throw new Error(`Falta la variable de entorno requerida: ${name}`);
    }

    values[name] = value;
  }

  return values;
}

/**
 * Proveedor elegido con `MATCHES_SYNC_PROVIDER`. Sin valor usa el por defecto.
 * Un valor desconocido lanza en vez de elegir uno por su cuenta: nunca se cae
 * a otro proveedor ni se consultan dos.
 */
export function resolveSyncProvider(env: NodeJS.ProcessEnv = process.env): SyncProviderName {
  const raw = env.MATCHES_SYNC_PROVIDER?.trim();

  if (!raw) {
    return DEFAULT_SYNC_PROVIDER;
  }

  if ((SYNC_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as SyncProviderName;
  }

  throw new Error(
    `MATCHES_SYNC_PROVIDER inválido: "${raw}". Valores permitidos: ${SYNC_PROVIDERS.join(', ')}.`,
  );
}

/**
 * Fecha opcional `MATCHES_SYNC_BACKFILL_FROM` (`YYYY-MM-DD`, WAT-274): adelanta
 * el inicio de la ventana de football-data.org para recuperar marcadores de
 * partidos ya terminados. Sin valor devuelve `undefined` (ventana normal). Un
 * valor que no es una fecha de calendario lanza, y el comando sale con código 2.
 */
export function resolveBackfillFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MATCHES_SYNC_BACKFILL_FROM?.trim();

  if (!raw) {
    return undefined;
  }

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;

  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`MATCHES_SYNC_BACKFILL_FROM inválido: "${raw}". Formato esperado: YYYY-MM-DD.`);
  }

  return raw;
}

export function loadSportsProviderEnv(env: NodeJS.ProcessEnv = process.env): SportsProviderEnv {
  return requireEnvVars(REQUIRED_SPORTS_PROVIDER_ENV_VARS, env);
}

export function loadFootballDataOrgEnv(env: NodeJS.ProcessEnv = process.env): FootballDataOrgEnv {
  return requireEnvVars(REQUIRED_FOOTBALL_DATA_ORG_ENV_VARS, env);
}
