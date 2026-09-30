import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const NONEXISTENT_USER_ID = '77777777-7777-7777-7777-777777777777';
const NONEXISTENT_MATCH_ID = '99999999-9999-9999-9999-999999999999';
// Partido sembrado por supabase/seed.sql (WAT-103) — mismo criterio que
// comment-constraints-checks.ts: evita depender de un módulo de Node para
// tener un match_id válido.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

function validWatchedMatchPayload(
  userId: string,
  matchId: string,
  overrides: Record<string, unknown> = {},
) {
  return { user_id: userId, match_id: matchId, ...overrides };
}

/**
 * Verifica que sea la base de datos, no la aplicación, la que garantice la
 * integridad de `watched_matches` (WAT-166): FKs válidas y una única fila
 * por `(user_id, match_id)`. Usa service_role porque acá interesa aislar el
 * comportamiento de los constraints, no el de RLS (ver
 * watched-matches-rls-checks.ts para eso).
 */
export async function checkWatchedMatchesConstraints(
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const userId = await createTempUserId(adminClient);

  const missingUserResult = await adminClient
    .from('watched_matches')
    .insert(validWatchedMatchPayload(NONEXISTENT_USER_ID, SEEDED_MATCH_ID));

  results.push({
    label: 'FK watched_matches_user_id_fkey rechaza user_id inexistente',
    passed: missingUserResult.error?.code === '23503',
    detail: missingUserResult.error
      ? `Postgres devolvió: ${missingUserResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  const missingMatchResult = await adminClient
    .from('watched_matches')
    .insert(validWatchedMatchPayload(userId, NONEXISTENT_MATCH_ID));

  results.push({
    label: 'FK watched_matches_match_id_fkey rechaza match_id inexistente',
    passed: missingMatchResult.error?.code === '23503',
    detail: missingMatchResult.error
      ? `Postgres devolvió: ${missingMatchResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  const validResult = await adminClient
    .from('watched_matches')
    .insert(validWatchedMatchPayload(userId, SEEDED_MATCH_ID));

  results.push({
    label: 'Un partido visto con user_id/match_id existentes se acepta',
    passed: !validResult.error,
    detail: validResult.error
      ? `Error inesperado: ${validResult.error.message}`
      : 'Insertado sin error.',
  });

  const duplicateResult = await adminClient
    .from('watched_matches')
    .insert(validWatchedMatchPayload(userId, SEEDED_MATCH_ID));

  results.push({
    label: 'PK watched_matches_pkey rechaza repetir (user_id, match_id)',
    passed: duplicateResult.error?.code === '23505',
    detail: duplicateResult.error
      ? `Postgres devolvió: ${duplicateResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  const otherUserId = await createTempUserId(adminClient);
  const otherUserResult = await adminClient
    .from('watched_matches')
    .insert(validWatchedMatchPayload(otherUserId, SEEDED_MATCH_ID));

  results.push({
    label: 'Un usuario distinto puede registrar el mismo partido de forma independiente',
    passed: !otherUserResult.error,
    detail: otherUserResult.error
      ? `Error inesperado: ${otherUserResult.error.message}`
      : 'Insertado sin error.',
  });

  return results;
}
