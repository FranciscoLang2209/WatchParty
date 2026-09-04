import { createClient } from '@supabase/supabase-js';
import { readWebEnv } from './env';
import { rememberAwareStorage } from './session-storage';

const env = readWebEnv();

/**
 * Cliente de Supabase usado exclusivamente para Auth y sesión.
 * No se debe usar `supabase.from(...)`: los datos se consumen desde la Node API.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // El destino real lo elige «Recordarme» en cada inicio de sesión.
    storage: rememberAwareStorage,
  },
});
