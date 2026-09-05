import { supabaseAuthClient } from '../../src/auth/supabase-auth-client.js';

const TEMP_USER_PASSWORD = 'Smoke-Test-Pass-1!';

function createTempEmail(prefix = 'smoke'): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}@watchparty.local`;
}

export async function getAccessToken(prefix?: string): Promise<string> {
  const email = createTempEmail(prefix);
  const { data, error } = await supabaseAuthClient.auth.signUp({
    email,
    password: TEMP_USER_PASSWORD,
  });

  if (error || !data.session?.access_token) {
    throw new Error(`No se pudo obtener un access token: ${error?.message ?? 'sesión vacía'}`);
  }

  console.log(`Usuario temporal: ${email}`);
  return data.session.access_token;
}
