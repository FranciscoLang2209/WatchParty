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

export function loadSportsProviderEnv(env: NodeJS.ProcessEnv = process.env): SportsProviderEnv {
  return requireEnvVars(REQUIRED_SPORTS_PROVIDER_ENV_VARS, env);
}

export function loadFootballDataOrgEnv(env: NodeJS.ProcessEnv = process.env): FootballDataOrgEnv {
  return requireEnvVars(REQUIRED_FOOTBALL_DATA_ORG_ENV_VARS, env);
}
