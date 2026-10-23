import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient, createTempUserId } from './utils/supabase-clients.js';
import { getOrCreateTestRoom } from './utils/room-fixture.js';
import { printResults, type CheckResult } from './utils/db-checks.js';
import { SupabaseUserStatisticsStore } from '../src/modules/statistics/infrastructure/supabase-user-statistics-store.js';
import type { UserStatistics } from '../src/modules/statistics/domain/user-statistics-store.js';

// Partidos sembrados por supabase/seed.sql (WAT-103). Existen siempre tras un
// `db reset`, sin importar la ventana de agenda de GET /matches.
const SEEDED_MATCHES = [
  'a1111111-1111-1111-1111-111111111111',
  'a2222222-2222-2222-2222-222222222222',
  'a3333333-3333-3333-3333-333333333333',
];

async function run(label: string, query: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await query;
  if (error) throw new Error(`No se pudo ${label}: ${error.message}`);
}

function describe(stats: UserStatistics): string {
  return `vistos=${stats.watchedMatches}, calificaciones=${stats.ratings}, comentarios=${stats.comments}`;
}

function equals(actual: UserStatistics, expected: UserStatistics): boolean {
  return (
    actual.watchedMatches === expected.watchedMatches &&
    actual.ratings === expected.ratings &&
    actual.comments === expected.comments
  );
}

async function comment(admin: SupabaseClient, roomId: string, authorId: string) {
  await run(
    'sembrar un comentario',
    admin.from('room_comments').insert({
      room_id: roomId,
      author_id: authorId,
      body: 'verify',
      client_request_id: crypto.randomUUID(),
    }),
  );
}

/**
 * Verifica `SupabaseUserStatisticsStore` (WAT-231) contra el Supabase local
 * con service_role, igual que el backend: conteos reales, edición de nota que
 * no suma, aislamiento entre usuarios y ceros sin actividad. Crea usuarios y
 * filas de prueba y borra las filas al terminar. Solo para local.
 */
async function main(): Promise<void> {
  const admin = createServiceRoleClient();
  const store = new SupabaseUserStatisticsStore(admin);
  const roomId = await getOrCreateTestRoom(admin);

  const active = await createTempUserId(admin);
  const other = await createTempUserId(admin);
  const idle = await createTempUserId(admin);
  const users = [active, other, idle];

  try {
    const results: CheckResult[] = [];

    const before = await store.getUserStatistics(idle);
    results.push({
      label: 'Usuario sin actividad: los tres totales en cero',
      passed: equals(before, { watchedMatches: 0, ratings: 0, comments: 0 }),
      detail: describe(before),
    });

    await run(
      'sembrar vistos',
      admin
        .from('watched_matches')
        .insert(SEEDED_MATCHES.map((match_id) => ({ user_id: active, match_id }))),
    );
    await run(
      'sembrar notas',
      admin.from('match_ratings').insert([
        { user_id: active, match_id: SEEDED_MATCHES[0], rating: 3 },
        { user_id: active, match_id: SEEDED_MATCHES[1], rating: 5 },
      ]),
    );
    for (let i = 0; i < 4; i += 1) await comment(admin, roomId, active);

    // Actividad de otro usuario sobre los mismos partidos y la misma sala.
    await run(
      'sembrar el visto de otro usuario',
      admin.from('watched_matches').insert({ user_id: other, match_id: SEEDED_MATCHES[0] }),
    );
    await run(
      'sembrar la nota de otro usuario',
      admin
        .from('match_ratings')
        .insert({ user_id: other, match_id: SEEDED_MATCHES[0], rating: 1 }),
    );
    await comment(admin, roomId, other);

    const counted = await store.getUserStatistics(active);
    results.push({
      label: 'Cuenta todos los registros propios (3 vistos, 2 notas, 4 comentarios)',
      passed: equals(counted, { watchedMatches: 3, ratings: 2, comments: 4 }),
      detail: describe(counted),
    });

    await run(
      'editar una nota',
      admin
        .from('match_ratings')
        .update({ rating: 1 })
        .eq('user_id', active)
        .eq('match_id', SEEDED_MATCHES[0]),
    );
    const afterEdit = await store.getUserStatistics(active);
    results.push({
      label: 'Editar una nota no agrega otra calificación',
      passed: afterEdit.ratings === 2,
      detail: describe(afterEdit),
    });

    const otherStats = await store.getUserStatistics(other);
    results.push({
      label: 'Otro usuario solo cuenta lo propio (1 visto, 1 nota, 1 comentario)',
      passed: equals(otherStats, { watchedMatches: 1, ratings: 1, comments: 1 }),
      detail: describe(otherStats),
    });

    const idleAfter = await store.getUserStatistics(idle);
    results.push({
      label: 'La actividad ajena no altera los ceros de un usuario sin actividad',
      passed: equals(idleAfter, { watchedMatches: 0, ratings: 0, comments: 0 }),
      detail: describe(idleAfter),
    });

    process.exitCode = printResults(results) ? 0 : 1;
  } finally {
    await admin.from('room_comments').delete().in('author_id', users);
    await admin.from('match_ratings').delete().in('user_id', users);
    await admin.from('watched_matches').delete().in('user_id', users);
  }
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
