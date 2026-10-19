import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';
import { SupabaseMatchStore } from '../../src/modules/matches/infrastructure/supabase-match-store.js';
import { SupabaseMatchCatalog } from '../../src/modules/matches/infrastructure/supabase-match-catalog.js';
import { SupabaseWatchedMatchStore } from '../../src/modules/watched/infrastructure/supabase-watched-match-store.js';
import { SupabaseMatchRatingStore } from '../../src/modules/ratings/infrastructure/supabase-match-rating-store.js';
import { MatchRatingService } from '../../src/modules/ratings/application/match-rating-service.js';

// Partidos sembrados por supabase/seed.sql (WAT-103): uno programado, uno en
// vivo y uno finalizado. Mismo criterio que match-ratings-constraints-checks.ts.
const SCHEDULED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';
const LIVE_MATCH_ID = 'a2222222-2222-2222-2222-222222222222';
const FINISHED_MATCH_ID = 'a3333333-3333-3333-3333-333333333333';
const NONEXISTENT_MATCH_ID = '99999999-9999-9999-9999-999999999999';

interface StoredRating {
  rating: number;
  created_at: string;
  updated_at: string;
}

async function readRows(client: SupabaseClient, userId: string, matchId: string) {
  return client
    .from('match_ratings')
    .select('rating, created_at, updated_at')
    .eq('user_id', userId)
    .eq('match_id', matchId);
}

/**
 * Verifica contra una base real (WAT-212) el comportamiento que los dobles de
 * vitest no pueden probar: que el `upsert` del store respete la PK de
 * `match_ratings`, que el trigger de WAT-211 mueva `updated_at` sin tocar
 * `created_at`, y que las reglas de elegibilidad del service
 * (existente + finalizado + visto) impidan escribir en la tabla real.
 *
 * Arma el mismo grafo que la API (catálogo → watched → ratings) y llama al
 * service directamente: cubre persistencia y reglas de negocio; el contrato
 * HTTP y el bearer los cubren los tests de supertest.
 */
export async function checkMatchRatingApi(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const catalog = new SupabaseMatchCatalog(new SupabaseMatchStore(adminClient));
  const watchedStore = new SupabaseWatchedMatchStore(adminClient, catalog);
  const ratingStore = new SupabaseMatchRatingStore(adminClient);
  const service = new MatchRatingService(catalog, watchedStore, ratingStore);

  const userId = await createTempUserId(adminClient);
  const otherUserId = await createTempUserId(adminClient);

  const unrated = await service.getOwnRating(userId, FINISHED_MATCH_ID);
  results.push({
    label: 'Sin nota previa, la consulta devuelve rating null',
    passed: unrated.kind === 'ok' && unrated.rating === null,
    detail: JSON.stringify(unrated),
  });

  const missing = await service.saveOwnRating(userId, NONEXISTENT_MATCH_ID, 4);
  results.push({
    label: 'Partido inexistente: match_not_found',
    passed: missing.kind === 'match_not_found',
    detail: JSON.stringify(missing),
  });

  for (const [label, matchId] of [
    ['programado', SCHEDULED_MATCH_ID],
    ['en vivo', LIVE_MATCH_ID],
  ] as const) {
    const notFinished = await service.saveOwnRating(userId, matchId, 4);
    const rows = await readRows(adminClient, userId, matchId);
    results.push({
      label: `Partido ${label}: match_not_finished y no se escribe ninguna fila`,
      passed: notFinished.kind === 'match_not_finished' && !rows.error && rows.data?.length === 0,
      detail: `${JSON.stringify(notFinished)}; filas=${rows.data?.length ?? 'error'}`,
    });
  }

  const notWatched = await service.saveOwnRating(userId, FINISHED_MATCH_ID, 4);
  const rowsNotWatched = await readRows(adminClient, userId, FINISHED_MATCH_ID);
  results.push({
    label: 'Finalizado pero no visto: match_not_watched y no se escribe ninguna fila',
    passed:
      notWatched.kind === 'match_not_watched' &&
      !rowsNotWatched.error &&
      rowsNotWatched.data?.length === 0,
    detail: `${JSON.stringify(notWatched)}; filas=${rowsNotWatched.data?.length ?? 'error'}`,
  });

  await watchedStore.setWatched(userId, FINISHED_MATCH_ID, true);

  const first = await service.saveOwnRating(userId, FINISHED_MATCH_ID, 4);
  const afterFirst = await readRows(adminClient, userId, FINISHED_MATCH_ID);
  const firstRow = afterFirst.data?.[0] as StoredRating | undefined;
  results.push({
    label: 'Finalizado y visto: se guarda la nota (una fila)',
    passed: first.kind === 'ok' && first.rating === 4 && afterFirst.data?.length === 1,
    detail: `${JSON.stringify(first)}; filas=${afterFirst.data?.length ?? 'error'}`,
  });

  const repeated = await service.saveOwnRating(userId, FINISHED_MATCH_ID, 4);
  const afterRepeat = await readRows(adminClient, userId, FINISHED_MATCH_ID);
  results.push({
    label: 'Repetir el mismo guardado no duplica la fila',
    passed: repeated.kind === 'ok' && afterRepeat.data?.length === 1,
    detail: `filas=${afterRepeat.data?.length ?? 'error'}`,
  });

  const edited = await service.saveOwnRating(userId, FINISHED_MATCH_ID, 2);
  const afterEdit = await readRows(adminClient, userId, FINISHED_MATCH_ID);
  const editedRow = afterEdit.data?.[0] as StoredRating | undefined;
  results.push({
    label: 'Editar la nota actualiza la misma fila (sin duplicar)',
    passed: edited.kind === 'ok' && editedRow?.rating === 2 && afterEdit.data?.length === 1,
    detail: `${JSON.stringify(edited)}; filas=${afterEdit.data?.length ?? 'error'}`,
  });

  const createdAtKept = !!firstRow && !!editedRow && firstRow.created_at === editedRow.created_at;
  const updatedAtAdvanced =
    !!firstRow &&
    !!editedRow &&
    new Date(editedRow.updated_at).getTime() > new Date(firstRow.updated_at).getTime();
  results.push({
    label: 'Editar conserva created_at y avanza updated_at (upsert + trigger)',
    passed: createdAtKept && updatedAtAdvanced,
    detail: `created_at conservado=${createdAtKept}, updated_at avanzó=${updatedAtAdvanced}`,
  });

  const read = await service.getOwnRating(userId, FINISHED_MATCH_ID);
  results.push({
    label: 'La consulta devuelve la nota editada',
    passed: read.kind === 'ok' && read.rating === 2,
    detail: JSON.stringify(read),
  });

  for (const invalid of [0, 6, -1, 3.5]) {
    const outcome = await ratingStore.saveRating(userId, FINISHED_MATCH_ID, invalid).then(
      () => 'sin error',
      (error: unknown) => (error instanceof RangeError ? 'RangeError' : 'otro error'),
    );
    const rows = await readRows(adminClient, userId, FINISHED_MATCH_ID);
    results.push({
      label: `El store rechaza rating = ${invalid} sin tocar la nota guardada`,
      passed:
        outcome === 'RangeError' && (rows.data?.[0] as StoredRating | undefined)?.rating === 2,
      detail: `resultado=${outcome}`,
    });
  }

  const otherBefore = await service.getOwnRating(otherUserId, FINISHED_MATCH_ID);
  results.push({
    label: 'Otro usuario no ve la nota ajena (rating null)',
    passed: otherBefore.kind === 'ok' && otherBefore.rating === null,
    detail: JSON.stringify(otherBefore),
  });

  await watchedStore.setWatched(otherUserId, FINISHED_MATCH_ID, true);
  const otherSave = await service.saveOwnRating(otherUserId, FINISHED_MATCH_ID, 5);
  const mine = await service.getOwnRating(userId, FINISHED_MATCH_ID);
  results.push({
    label: 'Otro usuario califica el mismo partido sin pisar la nota del primero',
    passed:
      otherSave.kind === 'ok' && otherSave.rating === 5 && mine.kind === 'ok' && mine.rating === 2,
    detail: `otro=${JSON.stringify(otherSave)}; propia=${JSON.stringify(mine)}`,
  });

  await watchedStore.setWatched(userId, FINISHED_MATCH_ID, false);
  const keptAfterUnwatch = await service.getOwnRating(userId, FINISHED_MATCH_ID);
  const editAfterUnwatch = await service.saveOwnRating(userId, FINISHED_MATCH_ID, 3);
  results.push({
    label: 'Si deshace "visto": la nota se conserva al leer y editarla vuelve a exigir "visto"',
    passed:
      keptAfterUnwatch.kind === 'ok' &&
      keptAfterUnwatch.rating === 2 &&
      editAfterUnwatch.kind === 'match_not_watched',
    detail: `lectura=${JSON.stringify(keptAfterUnwatch)}; edición=${JSON.stringify(editAfterUnwatch)}`,
  });

  return results;
}
