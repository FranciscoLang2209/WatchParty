import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const NONEXISTENT_USER_ID = '77777777-7777-7777-7777-777777777777';
const NONEXISTENT_MATCH_ID = '99999999-9999-9999-9999-999999999999';
// Partido sembrado por supabase/seed.sql (WAT-103) — mismo criterio que
// watched-matches-constraints-checks.ts.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';
const OTHER_SEEDED_MATCH_ID = 'a2222222-2222-2222-2222-222222222222';

function validRatingPayload(
  userId: string,
  matchId: string,
  overrides: Record<string, unknown> = {},
) {
  return { user_id: userId, match_id: matchId, rating: 4, ...overrides };
}

function rejected(
  label: string,
  error: { code?: string; message: string } | null,
  expectedCode: string,
): CheckResult {
  return {
    label,
    passed: error?.code === expectedCode,
    detail: error
      ? `Postgres devolvió: ${error.message} (code=${error.code})`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  };
}

/**
 * Verifica que sea la base de datos, no la aplicación, la que garantice la
 * integridad de `match_ratings` (WAT-211): FKs válidas, una única nota por
 * `(user_id, match_id)`, entero entre 1 y 5 y timestamps para las métricas
 * mensuales. Usa service_role porque acá interesa aislar el comportamiento
 * de los constraints, no el de RLS (ver match-ratings-rls-checks.ts).
 */
export async function checkMatchRatingsConstraints(
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const userId = await createTempUserId(adminClient);

  const missingUser = await adminClient
    .from('match_ratings')
    .insert(validRatingPayload(NONEXISTENT_USER_ID, SEEDED_MATCH_ID));
  results.push(
    rejected(
      'FK match_ratings_user_id_fkey rechaza user_id inexistente',
      missingUser.error,
      '23503',
    ),
  );

  const missingMatch = await adminClient
    .from('match_ratings')
    .insert(validRatingPayload(userId, NONEXISTENT_MATCH_ID));
  results.push(
    rejected(
      'FK match_ratings_match_id_fkey rechaza match_id inexistente',
      missingMatch.error,
      '23503',
    ),
  );

  // Rango: 0 y 6 (enteros fuera de rango) violan el CHECK (23514); 3.5 y
  // texto no son smallint válido (22P02); null viola NOT NULL (23502).
  const invalid: Array<{ label: string; value: unknown; code: string }> = [
    { label: 'rating = 0', value: 0, code: '23514' },
    { label: 'rating = 6', value: 6, code: '23514' },
    { label: 'rating negativo (-1)', value: -1, code: '23514' },
    { label: 'rating decimal (3.5)', value: 3.5, code: '22P02' },
    { label: 'rating no numérico ("abc")', value: 'abc', code: '22P02' },
    { label: 'rating null', value: null, code: '23502' },
  ];
  for (const { label, value, code } of invalid) {
    const response = await adminClient
      .from('match_ratings')
      .insert(validRatingPayload(userId, SEEDED_MATCH_ID, { rating: value }));
    results.push(rejected(`Se rechaza ${label}`, response.error, code));
  }

  const noRowsAfterInvalid = await adminClient
    .from('match_ratings')
    .select('user_id')
    .eq('user_id', userId);
  results.push({
    label: 'Ningún intento inválido dejó una fila guardada',
    passed: !noRowsAfterInvalid.error && (noRowsAfterInvalid.data?.length ?? -1) === 0,
    detail: noRowsAfterInvalid.error
      ? `Error inesperado: ${noRowsAfterInvalid.error.message}`
      : `Filas encontradas: ${noRowsAfterInvalid.data?.length ?? 0}`,
  });

  // Límites válidos: 1 y 5 se aceptan.
  for (const [rating, matchId] of [
    [1, SEEDED_MATCH_ID],
    [5, OTHER_SEEDED_MATCH_ID],
  ] as const) {
    const ok = await adminClient
      .from('match_ratings')
      .insert(validRatingPayload(userId, matchId, { rating }));
    results.push({
      label: `rating = ${rating} (límite del rango) se acepta`,
      passed: !ok.error,
      detail: ok.error ? `Error inesperado: ${ok.error.message}` : 'Insertado sin error.',
    });
  }

  const duplicate = await adminClient
    .from('match_ratings')
    .insert(validRatingPayload(userId, SEEDED_MATCH_ID, { rating: 3 }));
  results.push(
    rejected(
      'PK match_ratings_pkey rechaza una segunda nota para (user_id, match_id)',
      duplicate.error,
      '23505',
    ),
  );

  const otherUserId = await createTempUserId(adminClient);
  const otherUser = await adminClient
    .from('match_ratings')
    .insert(validRatingPayload(otherUserId, SEEDED_MATCH_ID, { rating: 2 }));
  results.push({
    label: 'Un usuario distinto puede calificar el mismo partido de forma independiente',
    passed: !otherUser.error,
    detail: otherUser.error
      ? `Error inesperado: ${otherUser.error.message}`
      : 'Insertado sin error.',
  });

  // Timestamps: updated_at avanza al cambiar la nota; created_at no.
  const before = await adminClient
    .from('match_ratings')
    .select('rating, created_at, updated_at')
    .eq('user_id', userId)
    .eq('match_id', SEEDED_MATCH_ID)
    .single();
  const update = await adminClient
    .from('match_ratings')
    .update({ rating: 2 })
    .eq('user_id', userId)
    .eq('match_id', SEEDED_MATCH_ID)
    .select('rating, created_at, updated_at')
    .single();

  const createdAtKept =
    !!before.data && !!update.data && before.data.created_at === update.data.created_at;
  const updatedAtAdvanced =
    !!before.data &&
    !!update.data &&
    new Date(update.data.updated_at).getTime() > new Date(before.data.updated_at).getTime();
  results.push({
    label: 'Cambiar la nota conserva created_at y avanza updated_at (trigger)',
    passed: !before.error && !update.error && createdAtKept && updatedAtAdvanced,
    detail:
      before.error || update.error
        ? `Error inesperado: ${(before.error ?? update.error)?.message}`
        : `created_at conservado=${createdAtKept}, updated_at avanzó=${updatedAtAdvanced}`,
  });

  const updateOutOfRange = await adminClient
    .from('match_ratings')
    .update({ rating: 9 })
    .eq('user_id', userId)
    .eq('match_id', SEEDED_MATCH_ID);
  results.push(
    rejected(
      'El CHECK de rango también se aplica al UPDATE (rating = 9)',
      updateOutOfRange.error,
      '23514',
    ),
  );

  return results;
}
