export interface SportsProviderEnv {
  API_FOOTBALL_BASE_URL: string;
  API_FOOTBALL_KEY: string;
}

const REQUIRED_SPORTS_PROVIDER_ENV_VARS = ['API_FOOTBALL_BASE_URL', 'API_FOOTBALL_KEY'] as const;

export function loadSportsProviderEnv(env: NodeJS.ProcessEnv = process.env): SportsProviderEnv {
  const values = {} as SportsProviderEnv;

  for (const name of REQUIRED_SPORTS_PROVIDER_ENV_VARS) {
    const value = env[name]?.trim();

    if (!value) {
      throw new Error(`Falta la variable de entorno requerida: ${name}`);
    }

    values[name] = value;
  }

  return values;
}
