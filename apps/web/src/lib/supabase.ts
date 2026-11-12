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
    // El enlace del correo de recuperación llega con la sesión en la URL: el cliente tiene que
    // leerla para emitir `PASSWORD_RECOVERY`, la señal que habilita el cambio de contraseña.
    // Sin esto el enlace se ignora y `/reset-password` siempre dice «enlace no válido».
    detectSessionInUrl: true,
    // El destino real lo elige «Recordarme» en cada inicio de sesión.
    storage: rememberAwareStorage,
  },
});
