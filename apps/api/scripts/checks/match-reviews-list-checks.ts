import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';
import { SupabaseMatchStore } from '../../src/modules/matches/infrastructure/supabase-match-store.js';
import { SupabaseMatchCatalog } from '../../src/modules/matches/infrastructure/supabase-match-catalog.js';
import { SupabaseWatchedMatchStore } from '../../src/modules/watched/infrastructure/supabase-watched-match-store.js';
import { SupabaseMatchRatingStore } from '../../src/modules/ratings/infrastructure/supabase-match-rating-store.js';
import { SupabaseMatchReviewStore } from '../../src/modules/reviews/infrastructure/supabase-match-review-store.js';
import { MatchReviewService } from '../../src/modules/reviews/application/match-review-service.js';
import {
  ANONYMOUS_REVIEW_AUTHOR_NAME,
  type PublicMatchReview,
} from '../../src/modules/reviews/domain/match-review-store.js';
import { createReviewsCursorCodec } from '../../src/modules/reviews/domain/match-review-cursor.js';

// Partido finalizado sembrado por supabase/seed.sql (WAT-103).
const MATCH_ID = 'a3333333-3333-3333-3333-333333333333';
const NONEXISTENT_MATCH_ID = '99999999-9999-9999-9999-999999999999';
const TAG = 'WAT-256 verify';
const TIE = '2026-01-01T10:00:00+00:00';

/**
 * Verifica contra una base real (WAT-256) lo que los dobles de vitest no
 * pueden probar: que el filtro de keyset de PostgREST `(created_at, user_id)`
 * funcione con microsegundos reales y con empates exactos de `created_at`,
 * que el nombre visible salga de `profiles` (con etiqueta neutra si falta el
 * perfil) y que una reseña eliminada deje de listarse. Arma el mismo grafo
 * que la API y llama al service; el contrato HTTP lo cubren los tests de
 * supertest. Como el partido sembrado puede tener reseñas de otros scripts,
 * se recorre todo el listado y se evalúa sobre las reseñas de este script
 * (marcadas con TAG), que además se limpian al terminar.
 */
export async function checkMatchReviewsList(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const catalog = new SupabaseMatchCatalog(new SupabaseMatchStore(adminClient));
  const watchedStore = new SupabaseWatchedMatchStore(adminClient, catalog);
  const ratingStore = new SupabaseMatchRatingStore(adminClient);
  const reviewStore = new SupabaseMatchReviewStore(adminClient);
  const service = new MatchReviewService(catalog, watchedStore, ratingStore, reviewStore);

  const withProfile = await createTempUserId(adminClient);
  const withoutProfile = await createTempUserId(adminClient);
  const tieA = await createTempUserId(adminClient);
  const tieB = await createTempUserId(adminClient);
  const users = [withProfile, withoutProfile, tieA, tieB];

  await adminClient.from('profiles').insert([
    { user_id: withProfile, display_name: 'Ana Verify' },
    { user_id: tieA, display_name: 'Tie A' },
    { user_id: tieB, display_name: 'Tie B' },
  ]);

  try {
    // Dos reseñas con created_at real (microsegundos) y dos con empate exacto.
    for (const [user, label] of [
      [withProfile, 'con perfil'],
      [withoutProfile, 'sin perfil'],
    ] as const) {
      await watchedStore.setWatched(user, MATCH_ID, true);
      await ratingStore.saveRating(user, MATCH_ID, 5);
      await service.saveOwnReview(user, MATCH_ID, `${TAG} ${label}`);
    }
    await adminClient.from('match_reviews').insert([
      { user_id: tieA, match_id: MATCH_ID, body: `${TAG} empate A`, created_at: TIE },
      { user_id: tieB, match_id: MATCH_ID, body: `${TAG} empate B`, created_at: TIE },
    ]);

    // Clave descartable solo para este chequeo; el servidor usa REVIEWS_CURSOR_SECRET.
    const cursorCodec = createReviewsCursorCodec(randomBytes(32).toString('base64'));

    const walk = async (limit: number): Promise<PublicMatchReview[] | string> => {
      const all: PublicMatchReview[] = [];
      let after;
      for (let guard = 0; guard < 500; guard++) {
        const result = await service.listMatchReviews(MATCH_ID, { limit, ...(after && { after }) });
        if (result.kind !== 'ok') return `inesperado: ${result.kind}`;
        all.push(...result.page.items);
        if (!result.page.nextCursor) return all;
        // Pasa por el cursor opaco, como lo haría un cliente real.
        after = cursorCodec.decode(cursorCodec.encode(result.page.nextCursor)) ?? undefined;
        if (!after) return 'el cursor opaco no sobrevivió al viaje de ida y vuelta';
      }
      return 'la paginación no terminó';
    };

    const mine = (items: PublicMatchReview[]) => items.filter((i) => i.body.startsWith(TAG));
    const key = (i: PublicMatchReview) => `${i.createdAt}|${i.body}`;

    const one = await walk(1);
    const two = await walk(2);
    const big = await walk(50);

    for (const [label, got] of [
      ['limit 1', one],
      ['limit 2', two],
      ['limit 50', big],
    ] as const) {
      if (typeof got === 'string') {
        results.push({ label: `Paginación con ${label}`, passed: false, detail: got });
        continue;
      }
      const keys = got.map(key);
      results.push({
        label: `Paginación con ${label}: no repite ninguna reseña`,
        passed: new Set(keys).size === keys.length,
        detail: `${got.length} reseñas recorridas`,
      });
      results.push({
        label: `Paginación con ${label}: aparecen las 4 reseñas del script`,
        passed: mine(got).length === 4,
        detail: `encontradas=${mine(got).length}`,
      });
    }

    if (typeof one !== 'string' && typeof two !== 'string' && typeof big !== 'string') {
      results.push({
        label: 'El orden es el mismo con cualquier tamaño de página',
        passed:
          JSON.stringify(one.map(key)) === JSON.stringify(big.map(key)) &&
          JSON.stringify(two.map(key)) === JSON.stringify(big.map(key)),
        detail: 'limit 1, 2 y 50 coinciden',
      });

      const dates = big.map((i) => i.createdAt);
      results.push({
        label: 'Orden por fecha descendente (la más reciente primero)',
        passed: dates.every((d, i) => i === 0 || Date.parse(dates[i - 1]!) >= Date.parse(d)),
        detail: `${dates.length} fechas`,
      });

      const ties = big.filter((i) => i.createdAt.startsWith('2026-01-01T10:00:00'));
      results.push({
        label: 'Empate exacto de created_at: ambas reseñas aparecen, una sola vez cada una',
        passed:
          ties.filter((i) => i.body.endsWith('empate A')).length === 1 &&
          ties.filter((i) => i.body.endsWith('empate B')).length === 1,
        detail: ties.map((i) => i.body).join(' | '),
      });

      const named = mine(big);
      const nameOf = (suffix: string) => named.find((i) => i.body.endsWith(suffix))?.authorName;
      results.push({
        label: 'El nombre visible sale del perfil',
        passed: nameOf('con perfil') === 'Ana Verify' && nameOf('empate A') === 'Tie A',
        detail: `${nameOf('con perfil')} / ${nameOf('empate A')}`,
      });
      results.push({
        label: 'Sin perfil: etiqueta neutra',
        passed: nameOf('sin perfil') === ANONYMOUS_REVIEW_AUTHOR_NAME,
        detail: String(nameOf('sin perfil')),
      });
      results.push({
        label: 'Los items solo tienen authorName, body y createdAt',
        passed: big.every((i) => Object.keys(i).sort().join() === 'authorName,body,createdAt'),
        detail: 'sin user_id, email ni nota',
      });
    }

    const missing = await service.listMatchReviews(NONEXISTENT_MATCH_ID, { limit: 5 });
    results.push({
      label: 'Partido inexistente: match_not_found',
      passed: missing.kind === 'match_not_found',
      detail: JSON.stringify(missing),
    });

    await service.deleteOwnReview(withProfile, MATCH_ID);
    const afterDelete = await walk(50);
    results.push({
      label: 'Una reseña eliminada deja de aparecer; las demás siguen',
      passed:
        typeof afterDelete !== 'string' &&
        !afterDelete.some((i) => i.body.endsWith('con perfil')) &&
        mine(afterDelete).length === 3,
      detail:
        typeof afterDelete === 'string' ? afterDelete : `restantes=${mine(afterDelete).length}`,
    });
  } finally {
    await adminClient.from('match_reviews').delete().in('user_id', users).eq('match_id', MATCH_ID);
    await adminClient.from('match_ratings').delete().in('user_id', users).eq('match_id', MATCH_ID);
    await adminClient.from('profiles').delete().in('user_id', users);
  }

  return results;
}
