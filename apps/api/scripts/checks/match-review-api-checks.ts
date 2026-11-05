import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';
import { SupabaseMatchStore } from '../../src/modules/matches/infrastructure/supabase-match-store.js';
import { SupabaseMatchCatalog } from '../../src/modules/matches/infrastructure/supabase-match-catalog.js';
import { SupabaseWatchedMatchStore } from '../../src/modules/watched/infrastructure/supabase-watched-match-store.js';
import { SupabaseMatchRatingStore } from '../../src/modules/ratings/infrastructure/supabase-match-rating-store.js';
import { SupabaseMatchReviewStore } from '../../src/modules/reviews/infrastructure/supabase-match-review-store.js';
import { MatchReviewService } from '../../src/modules/reviews/application/match-review-service.js';

// Partido finalizado sembrado por supabase/seed.sql (WAT-103).
const FINISHED_MATCH_ID = 'a3333333-3333-3333-3333-333333333333';
const NONEXISTENT_MATCH_ID = '99999999-9999-9999-9999-999999999999';

async function countRows(client: SupabaseClient, table: string, userId: string, matchId: string) {
  const { data, error } = await client
    .from(table)
    .select('user_id')
    .eq('user_id', userId)
    .eq('match_id', matchId);
  return error ? null : (data?.length ?? 0);
}

/**
 * Verifica contra una base real (WAT-255) lo que los dobles de vitest no
 * pueden probar: que `deleteReview` borre solo la fila propia de
 * `match_reviews` (PK `(user_id, match_id)`), sea idempotente, funcione con
 * "visto" deshecho y deje intactas la nota (`match_ratings`) y la reseña de
 * otro usuario. Arma el mismo grafo que la API y llama al service
 * directamente; el contrato HTTP lo cubren los tests de supertest.
 */
export async function checkMatchReviewApi(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const catalog = new SupabaseMatchCatalog(new SupabaseMatchStore(adminClient));
  const watchedStore = new SupabaseWatchedMatchStore(adminClient, catalog);
  const ratingStore = new SupabaseMatchRatingStore(adminClient);
  const reviewStore = new SupabaseMatchReviewStore(adminClient);
  const service = new MatchReviewService(catalog, watchedStore, ratingStore, reviewStore);

  const userId = await createTempUserId(adminClient);
  const otherUserId = await createTempUserId(adminClient);

  for (const id of [userId, otherUserId]) {
    await watchedStore.setWatched(id, FINISHED_MATCH_ID, true);
    await ratingStore.saveRating(id, FINISHED_MATCH_ID, 4);
    await service.saveOwnReview(id, FINISHED_MATCH_ID, `Reseña de ${id.slice(0, 8)}`);
  }

  const missing = await service.deleteOwnReview(userId, NONEXISTENT_MATCH_ID);
  results.push({
    label: 'Partido inexistente: match_not_found y no se borra nada',
    passed:
      missing.kind === 'match_not_found' &&
      (await countRows(adminClient, 'match_reviews', userId, FINISHED_MATCH_ID)) === 1,
    detail: JSON.stringify(missing),
  });

  const first = await service.deleteOwnReview(userId, FINISHED_MATCH_ID);
  results.push({
    label: 'Eliminar borra la fila propia de match_reviews',
    passed:
      first.kind === 'ok' &&
      (await countRows(adminClient, 'match_reviews', userId, FINISHED_MATCH_ID)) === 0,
    detail: JSON.stringify(first),
  });

  results.push({
    label: 'Eliminar conserva la nota propia (match_ratings)',
    passed: (await ratingStore.findRating(userId, FINISHED_MATCH_ID)) === 4,
    detail: `nota=${await ratingStore.findRating(userId, FINISHED_MATCH_ID)}`,
  });

  results.push({
    label: 'Eliminar no toca la reseña de otro usuario',
    passed: (await countRows(adminClient, 'match_reviews', otherUserId, FINISHED_MATCH_ID)) === 1,
    detail: 'reseña ajena intacta',
  });

  const repeated = await service.deleteOwnReview(userId, FINISHED_MATCH_ID);
  results.push({
    label: 'Repetir el borrado no falla y deja el mismo estado',
    passed:
      repeated.kind === 'ok' &&
      (await countRows(adminClient, 'match_reviews', userId, FINISHED_MATCH_ID)) === 0,
    detail: JSON.stringify(repeated),
  });

  // Visto deshecho: la reseña ajena se borra igual y la nota se conserva.
  await watchedStore.setWatched(otherUserId, FINISHED_MATCH_ID, false);
  const unwatched = await service.deleteOwnReview(otherUserId, FINISHED_MATCH_ID);
  results.push({
    label: 'Con "visto" deshecho también se elimina y la nota se conserva',
    passed:
      unwatched.kind === 'ok' &&
      (await countRows(adminClient, 'match_reviews', otherUserId, FINISHED_MATCH_ID)) === 0 &&
      (await ratingStore.findRating(otherUserId, FINISHED_MATCH_ID)) === 4,
    detail: JSON.stringify(unwatched),
  });

  return results;
}
