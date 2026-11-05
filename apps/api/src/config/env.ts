const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'WEB_ORIGIN',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

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

/**
 * Clave con la que se cifra el cursor de `GET /matches/:matchId/reviews`
 * (WAT-256). Va aparte de `REQUIRED_ENV_VARS` a propósito: `env.ts` también lo
 * importan los comandos de sincronización, que no usan reseñas y no deben
 * exigirla. La lee solo la composición de `app.ts`, que falla al arrancar si
 * falta (mismo criterio que el resto: sin valor por defecto).
 */
export function readReviewsCursorSecret(): string {
  const value = process.env.REVIEWS_CURSOR_SECRET;

  if (!value) {
    throw new Error('Falta la variable de entorno requerida: REVIEWS_CURSOR_SECRET');
  }

  return value;
}
