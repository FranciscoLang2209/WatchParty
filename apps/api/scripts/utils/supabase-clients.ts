import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisá tu archivo .env.`);
  }
  return value;
}

/**
 * Cliente con privilegios de administrador: salta RLS por completo.
 * Es el único que debería usarse para probar constraints y funciones de lease,
 * porque simula al backend real (Node), el único que en producción tiene esta key.
 */
export function createServiceRoleClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceRoleKey);
}

/** Cliente sin sesión: simula un visitante anónimo. Debe ver todo bloqueado por RLS. */
export function createAnonClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  return createClient(url, anonKey);
}

/**
 * Cliente logueado como un usuario común (rol "authenticated").
 * También debe ver todo bloqueado, porque nuestras políticas de RLS
 * no le dan ningún permiso a este rol sobre datos deportivos.
 */
export function createAuthenticatedClient(accessToken: string): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
const TEMP_USER_PASSWORD = 'Verify-Schema-Pass-1!';

function createTempEmail(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `verify-schema-${suffix}@watchparty.local`;
}

/**
 * Crea un usuario descartable y devuelve su access token.
 * Sirve para armar un cliente "authenticated" real y probar que RLS
 * también le niega el acceso a un usuario logueado, no solo a un anónimo.
 */
export async function getTempUserAccessToken(): Promise<string> {
  const client = createAnonClient();
  const email = createTempEmail();
  const { data, error } = await client.auth.signUp({ email, password: TEMP_USER_PASSWORD });
  if (error || !data.session?.access_token) {
    throw new Error(`No se pudo crear un usuario temporal: ${error?.message ?? 'sesión vacía'}`);
  }
  return data.session.access_token;
}
