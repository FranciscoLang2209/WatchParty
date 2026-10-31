import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const NONEXISTENT_USER_ID = '77777777-7777-7777-7777-777777777777';
const NONEXISTENT_MATCH_ID = '99999999-9999-9999-9999-999999999999';
// Partidos sembrados por supabase/seed.sql (WAT-103) — mismo criterio que
// match-ratings-constraints-checks.ts.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';
const OTHER_SEEDED_MATCH_ID = 'a2222222-2222-2222-2222-222222222222';

function validReviewPayload(
  userId: string,
  matchId: string,
  overrides: Record<string, unknown> = {},
) {
  return { user_id: userId, match_id: matchId, body: 'Gran partido', ...overrides };
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
 * integridad de `match_reviews` (WAT-252): FKs válidas, una única reseña por
 * `(user_id, match_id)`, texto de 1 a 500 caracteres y timestamps. Usa
 * service_role porque acá interesa aislar los constraints, no RLS (ver
 * match-reviews-rls-checks.ts).
 */
export async function checkMatchReviewsConstraints(
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const userId = await createTempUserId(adminClient);

  const missingUser = await adminClient
    .from('match_reviews')
    .insert(validReviewPayload(NONEXISTENT_USER_ID, SEEDED_MATCH_ID));
  results.push(
    rejected(
      'FK match_reviews_user_id_fkey rechaza user_id inexistente',
      missingUser.error,
      '23503',
    ),
  );

  const missingMatch = await adminClient
    .from('match_reviews')
    .insert(validReviewPayload(userId, NONEXISTENT_MATCH_ID));
  results.push(
    rejected(
      'FK match_reviews_match_id_fkey rechaza match_id inexistente',
      missingMatch.error,
      '23503',
    ),
  );

  // Texto: vacío, solo espacios y 501 caracteres violan el CHECK (23514);
  // null viola NOT NULL (23502).
  const invalid: Array<{ label: string; value: unknown; code: string }> = [
    { label: 'texto vacío', value: '', code: '23514' },
    { label: 'texto de solo espacios', value: '   \n\t ', code: '23514' },
    { label: 'texto de 501 caracteres', value: 'a'.repeat(501), code: '23514' },
    {
      label: '500 caracteres más un espacio al final (501)',
      value: 'a'.repeat(500) + ' ',
      code: '23514',
    },
    {
      label: 'un espacio al inicio más 500 caracteres (501)',
      value: ' ' + 'a'.repeat(500),
      code: '23514',
    },
    {
      label: 'texto corto rellenado con 1.000.000 de espacios',
      value: 'a' + ' '.repeat(1_000_000),
      code: '23514',
    },
    { label: 'texto null', value: null, code: '23502' },
  ];
  for (const { label, value, code } of invalid) {
    const response = await adminClient
      .from('match_reviews')
      .insert(validReviewPayload(userId, SEEDED_MATCH_ID, { body: value }));
    results.push(rejected(`Se rechaza ${label}`, response.error, code));
  }

  const noRowsAfterInvalid = await adminClient
    .from('match_reviews')
    .select('user_id')
    .eq('user_id', userId);
  results.push({
    label: 'Ningún intento inválido dejó una fila guardada',
    passed: !noRowsAfterInvalid.error && (noRowsAfterInvalid.data?.length ?? -1) === 0,
    detail: noRowsAfterInvalid.error
      ? `Error inesperado: ${noRowsAfterInvalid.error.message}`
      : `Filas encontradas: ${noRowsAfterInvalid.data?.length ?? 0}`,
  });

  // Límites válidos: 1 y 500 caracteres se aceptan.
  for (const [body, matchId] of [
    ['a', SEEDED_MATCH_ID],
    ['b'.repeat(500), OTHER_SEEDED_MATCH_ID],
  ] as const) {
    const ok = await adminClient
      .from('match_reviews')
      .insert(validReviewPayload(userId, matchId, { body }));
    results.push({
      label: `Texto de ${body.length} caracteres (límite del rango) se acepta`,
      passed: !ok.error,
      detail: ok.error ? `Error inesperado: ${ok.error.message}` : 'Insertado sin error.',
    });
  }

  const duplicate = await adminClient
    .from('match_reviews')
    .insert(validReviewPayload(userId, SEEDED_MATCH_ID, { body: 'Otra reseña' }));
  results.push(
    rejected(
      'PK match_reviews_pkey rechaza una segunda reseña para (user_id, match_id)',
      duplicate.error,
      '23505',
    ),
  );

  const otherUserId = await createTempUserId(adminClient);
  const otherUser = await adminClient
    .from('match_reviews')
    .insert(validReviewPayload(otherUserId, SEEDED_MATCH_ID, { body: 'Mi opinión' }));
  results.push({
    label: 'Un usuario distinto puede reseñar el mismo partido de forma independiente',
    passed: !otherUser.error,
    detail: otherUser.error
      ? `Error inesperado: ${otherUser.error.message}`
      : 'Insertado sin error.',
  });

  // Timestamps: updated_at avanza al editar el texto; created_at no.
  const before = await adminClient
    .from('match_reviews')
    .select('body, created_at, updated_at')
    .eq('user_id', userId)
    .eq('match_id', SEEDED_MATCH_ID)
    .single();
  const update = await adminClient
    .from('match_reviews')
    .update({ body: 'Texto editado' })
    .eq('user_id', userId)
    .eq('match_id', SEEDED_MATCH_ID)
    .select('body, created_at, updated_at')
    .single();

  const createdAtKept =
    !!before.data && !!update.data && before.data.created_at === update.data.created_at;
  const updatedAtAdvanced =
    !!before.data &&
    !!update.data &&
    new Date(update.data.updated_at).getTime() > new Date(before.data.updated_at).getTime();
  results.push({
    label: 'Editar el texto conserva created_at y avanza updated_at (trigger)',
    passed: !before.error && !update.error && createdAtKept && updatedAtAdvanced,
    detail:
      before.error || update.error
        ? `Error inesperado: ${(before.error ?? update.error)?.message}`
        : `created_at conservado=${createdAtKept}, updated_at avanzó=${updatedAtAdvanced}`,
  });

  for (const { label, value } of [
    { label: 'texto vacío', value: '' },
    { label: 'texto de 501 caracteres', value: 'c'.repeat(501) },
    { label: '500 caracteres más un espacio al final (501)', value: 'c'.repeat(500) + ' ' },
    { label: 'un espacio al inicio más 500 caracteres (501)', value: ' ' + 'c'.repeat(500) },
  ]) {
    const updateInvalid = await adminClient
      .from('match_reviews')
      .update({ body: value })
      .eq('user_id', userId)
      .eq('match_id', SEEDED_MATCH_ID);
    results.push(
      rejected(
        `El CHECK de largo también se aplica al UPDATE (${label})`,
        updateInvalid.error,
        '23514',
      ),
    );
  }

  return results;
}
