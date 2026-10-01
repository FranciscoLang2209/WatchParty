import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const PERMISSION_DENIED = '42501';
// Partido sembrado por supabase/seed.sql (WAT-103) — mismo criterio que
// watched-matches-constraints-checks.ts.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

/**
 * Verifica que ni un visitante anónimo ni un usuario autenticado común
 * puedan leer ni escribir `watched_matches` de forma directa — mismo
 * criterio que profile-rls-checks.ts aplica a `profiles`. El único acceso
 * privilegiado es vía service_role, que en este proyecto solo usa el
 * backend a través del cliente servidor de WAT-106.
 */
export async function checkWatchedMatchesRls(
  anonClient: SupabaseClient,
  authenticatedClient: SupabaseClient,
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const ownerId = await createTempUserId(adminClient);
  const seeded = await adminClient
    .from('watched_matches')
    .insert({ user_id: ownerId, match_id: SEEDED_MATCH_ID });

  if (seeded.error) {
    throw new Error(`No se pudo sembrar un partido visto de prueba: ${seeded.error.message}`);
  }

  const roles: Array<{ label: string; client: SupabaseClient }> = [
    { label: 'anon', client: anonClient },
    { label: 'un usuario autenticado (de otro usuario)', client: authenticatedClient },
  ];

  for (const role of roles) {
    const read = await role.client.from('watched_matches').select('*');
    results.push({
      label: `RLS: ${role.label} no puede leer "watched_matches"`,
      passed: read.error?.code === PERMISSION_DENIED,
      detail: read.error
        ? `Postgres devolvió: ${read.error.message} (code=${read.error.code})`
        : `La lectura no fue rechazada (devolvió ${read.data?.length ?? 0} filas).`,
    });

    const insert = await role.client
      .from('watched_matches')
      .insert({ user_id: await createTempUserId(adminClient), match_id: SEEDED_MATCH_ID });
    results.push({
      label: `RLS: ${role.label} no puede insertar en "watched_matches"`,
      passed: insert.error?.code === PERMISSION_DENIED,
      detail: insert.error
        ? `Postgres devolvió: ${insert.error.message} (code=${insert.error.code})`
        : 'La inserción no fue rechazada (no debería haber tenido éxito).',
    });

    const update = await role.client
      .from('watched_matches')
      .update({ created_at: new Date().toISOString() })
      .eq('user_id', ownerId)
      .eq('match_id', SEEDED_MATCH_ID);
    results.push({
      label: `RLS: ${role.label} no puede actualizar un partido visto de otro usuario en "watched_matches"`,
      passed: update.error?.code === PERMISSION_DENIED,
      detail: update.error
        ? `Postgres devolvió: ${update.error.message} (code=${update.error.code})`
        : 'La actualización no fue rechazada (no debería haber tenido éxito).',
    });

    const del = await role.client
      .from('watched_matches')
      .delete()
      .eq('user_id', ownerId)
      .eq('match_id', SEEDED_MATCH_ID);
    results.push({
      label: `RLS: ${role.label} no puede borrar un partido visto de otro usuario en "watched_matches"`,
      passed: del.error?.code === PERMISSION_DENIED,
      detail: del.error
        ? `Postgres devolvió: ${del.error.message} (code=${del.error.code})`
        : 'El borrado no fue rechazado (no debería haber tenido éxito).',
    });
  }

  const adminRead = await adminClient.from('watched_matches').select('*').limit(1);
  results.push({
    label: 'RLS: service_role sí puede leer "watched_matches"',
    passed: !adminRead.error,
    detail: adminRead.error
      ? `Error inesperado: ${adminRead.error.message}`
      : `Filas devueltas: ${adminRead.data?.length ?? 0}`,
  });

  return results;
}
