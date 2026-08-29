const REQUIRED_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'WEB_ORIGIN'] as const;

type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

function readEnv(): Record<RequiredEnvVar, string> {
  const values = {} as Record<RequiredEnvVar, string>;

  for (const name of REQUIRED_ENV_VARS) {
    const value = process.env[name];

    if (!value) {
      throw new Error(`Falta la variable de entorno requerida: ${name}`);
    }

    values[name] = value;
  }

  return values;
}

export const env = readEnv();
