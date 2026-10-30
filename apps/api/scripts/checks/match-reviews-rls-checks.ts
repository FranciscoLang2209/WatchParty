import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const PERMISSION_DENIED = '42501';
// Partido sembrado por supabase/seed.sql (WAT-103) — mismo criterio que
// match-reviews-constraints-checks.ts.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

/**
 * Verifica que ni un visitante anónimo ni un usuario autenticado común
 * puedan leer ni escribir `match_reviews` de forma directa — mismo
 * criterio que profile-rls-checks.ts aplica a `profiles`. El único acceso
 * privilegiado es vía service_role, que en este proyecto solo usa el
 * backend a través del cliente servidor de WAT-106.
 */
export async function checkMatchReviewsRls(
  anonClient: SupabaseClient,
  authenticatedClient: SupabaseClient,
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const ownerId = await createTempUserId(adminClient);
  const seeded = await adminClient
    .from('match_reviews')
    .insert({ user_id: ownerId, match_id: SEEDED_MATCH_ID, body: 'Reseña de prueba' });

  if (seeded.error) {
    throw new Error(`No se pudo sembrar una reseña de prueba: ${seeded.error.message}`);
  }

  const roles: Array<{ label: string; client: SupabaseClient }> = [
    { label: 'anon', client: anonClient },
    { label: 'un usuario autenticado (de otro usuario)', client: authenticatedClient },
  ];

  for (const role of roles) {
    const read = await role.client.from('match_reviews').select('*');
    results.push({
      label: `RLS: ${role.label} no puede leer "match_reviews"`,
      passed: read.error?.code === PERMISSION_DENIED,
      detail: read.error
        ? `Postgres devolvió: ${read.error.message} (code=${read.error.code})`
        : `La lectura no fue rechazada (devolvió ${read.data?.length ?? 0} filas).`,
    });

    const insert = await role.client.from('match_reviews').insert({
      user_id: await createTempUserId(adminClient),
      match_id: SEEDED_MATCH_ID,
      body: 'Reseña de prueba',
    });
    results.push({
      label: `RLS: ${role.label} no puede insertar en "match_reviews"`,
      passed: insert.error?.code === PERMISSION_DENIED,
      detail: insert.error
        ? `Postgres devolvió: ${insert.error.message} (code=${insert.error.code})`
        : 'La inserción no fue rechazada (no debería haber tenido éxito).',
    });

    const update = await role.client
      .from('match_reviews')
      .update({ body: 'Texto alterado' })
      .eq('user_id', ownerId)
      .eq('match_id', SEEDED_MATCH_ID);
    results.push({
      label: `RLS: ${role.label} no puede actualizar una reseña de otro usuario en "match_reviews"`,
      passed: update.error?.code === PERMISSION_DENIED,
      detail: update.error
        ? `Postgres devolvió: ${update.error.message} (code=${update.error.code})`
        : 'La actualización no fue rechazada (no debería haber tenido éxito).',
    });

    const del = await role.client
      .from('match_reviews')
      .delete()
      .eq('user_id', ownerId)
      .eq('match_id', SEEDED_MATCH_ID);
    results.push({
      label: `RLS: ${role.label} no puede borrar una reseña de otro usuario en "match_reviews"`,
      passed: del.error?.code === PERMISSION_DENIED,
      detail: del.error
        ? `Postgres devolvió: ${del.error.message} (code=${del.error.code})`
        : 'El borrado no fue rechazado (no debería haber tenido éxito).',
    });
  }

  const untouched = await adminClient
    .from('match_reviews')
    .select('body')
    .eq('user_id', ownerId)
    .eq('match_id', SEEDED_MATCH_ID)
    .single();
  results.push({
    label: 'Los intentos denegados no modificaron ni borraron la reseña ajena',
    passed: !untouched.error && untouched.data?.body === 'Reseña de prueba',
    detail: untouched.error
      ? `Error inesperado: ${untouched.error.message}`
      : `body actual: ${untouched.data?.body}`,
  });

  const adminRead = await adminClient.from('match_reviews').select('*').limit(1);
  results.push({
    label: 'RLS: service_role sí puede leer "match_reviews"',
    passed: !adminRead.error,
    detail: adminRead.error
      ? `Error inesperado: ${adminRead.error.message}`
      : `Filas devueltas: ${adminRead.data?.length ?? 0}`,
  });

  return results;
}
