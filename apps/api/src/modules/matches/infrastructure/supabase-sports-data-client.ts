import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../../config/env.js';

/**
 * Cliente Supabase para persistir datos deportivos (`teams`, `matches`,
 * `provider_sync_state`), autenticado con la service_role key.
 *
 * Uso EXCLUSIVO del backend (Node): esta key salta RLS por completo y nunca
 * debe llegar al frontend, a un log ni a una respuesta HTTP — mismo cuidado
 * que ya aplica `createServiceRoleClient` en `scripts/utils/supabase-clients.ts`,
 * pero este cliente vive en `src` para uso en runtime, no solo en scripts de
 * verificación. Ver la guía oficial de claves de servicio de Supabase:
 * https://supabase.com/docs/guides/api/api-keys
 *
 * `SUPABASE_ANON_KEY` sigue siendo exclusiva de `auth/supabase-auth-client.ts`
 * (verificación de tokens de usuario): este cliente nunca la usa.
 *
 * No persiste sesión ni intenta refrescar tokens: no representa a ningún
 * usuario, es una credencial de servicio.
 */
export function createSupabaseSportsDataClient(): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
