import type { SupabaseClient } from '@supabase/supabase-js';

// Partido sembrado por supabase/seed.sql (WAT-103) — se reutiliza para no
// depender de un módulo `rooms` en Node: la sala de prueba se crea directo
// por SQL contra ese partido, igual de válida para probar constraints de las
// tablas que cuelgan de `rooms`.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

/**
 * Sala de prueba reutilizable entre corridas: si ya existe (porque el
 * script corrió antes sin un `db reset --local` de por medio), la
 * reutiliza en vez de chocar contra `rooms_match_id_key`.
 */
export async function getOrCreateTestRoom(adminClient: SupabaseClient): Promise<string> {
  const { data: existing } = await adminClient
    .from('rooms')
    .select('id')
    .eq('match_id', SEEDED_MATCH_ID)
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  const { data, error } = await adminClient
    .from('rooms')
    .insert({ match_id: SEEDED_MATCH_ID })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`No se pudo crear la sala de prueba: ${error?.message ?? 'sin datos'}`);
  }

  return (data as { id: string }).id;
}
