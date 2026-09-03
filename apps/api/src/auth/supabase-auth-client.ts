import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/**
 * Cliente de Supabase usado únicamente para verificar access tokens.
 * No persiste sesión propia ni usa una clave elevada (service_role).
 */
export const supabaseAuthClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
