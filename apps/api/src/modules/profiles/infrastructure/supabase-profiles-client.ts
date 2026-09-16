import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../../config/env.js';

/**
 * Cliente Supabase para leer/escribir `profiles` y `teams`, autenticado con
 * la service_role key.
 *
 * Mismo patrón que `createSupabaseSportsDataClient` (WAT-106,
 * `modules/matches/infrastructure/supabase-sports-data-client.ts`): "el
 * cliente servidor de WAT-106" es este approach — service_role, sin sesión,
 * exclusivo del backend — no una instancia compartida entre módulos. Cada
 * módulo instancia su propio cliente para no acoplar `profiles` a la
 * infraestructura interna de `matches` (bajo acoplamiento entre módulos).
 *
 * Uso EXCLUSIVO del backend (Node): esta key salta RLS por completo y nunca
 * debe llegar al frontend, a un log ni a una respuesta HTTP. Ver la guía
 * oficial de claves de servicio de Supabase:
 * https://supabase.com/docs/guides/api/api-keys
 *
 * No persiste sesión ni intenta refrescar tokens: no representa a ningún
 * usuario, es una credencial de servicio.
 */
export function createSupabaseProfilesClient(): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
