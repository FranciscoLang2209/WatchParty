import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseUserStatisticsStore } from './supabase-user-statistics-store.js';
import { UserStatisticsPersistenceError } from './user-statistics-persistence-error.js';

type Row = Record<string, string>;
type FakeError = { message: string };

interface FakeOptions {
  tables?: Partial<Record<string, Row[]>>;
  /** Error que devuelve la consulta de una tabla. */
  errors?: Partial<Record<string, FakeError>>;
  /** `count` que devuelve una tabla en lugar del real (respuestas corruptas). */
  counts?: Partial<Record<string, unknown>>;
}

/**
 * Doble de Supabase: cada tabla en memoria, `select(..., { count, head })`
 * más `eq` devuelven el conteo de filas que coinciden con el filtro, como
 * PostgREST con `count: 'exact'`.
 */
function makeFakeClient(options: FakeOptions = {}) {
  const from = vi.fn((table: string) => {
    let filter: [string, string] | null = null;
    let selectOptions: unknown;

    const builder = {
      select: vi.fn((_columns: string, opts?: unknown) => {
        selectOptions = opts;
        return builder;
      }),
      eq: vi.fn((column: string, value: string) => {
        filter = [column, value];
        return builder;
      }),
      then(resolve: (value: { count: unknown; error: FakeError | null; data: null }) => void) {
        const error = options.errors?.[table] ?? null;
        const rows = (options.tables?.[table] ?? []).filter(
          (row) => filter !== null && row[filter[0]] === filter[1],
        );
        const count = table in (options.counts ?? {}) ? options.counts![table] : rows.length;
        resolve({ count: error ? null : count, error, data: null });
      },
      get selectOptions() {
        return selectOptions;
      },
    };

    return builder;
  });

  return { from };
}

const asClient = (fake: ReturnType<typeof makeFakeClient>) => fake as unknown as SupabaseClient;

const USER_ID = 'u1111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = 'u2222222-2222-4222-8222-222222222222';
const MATCH_1 = 'a1111111-1111-4111-8111-111111111111';
const MATCH_2 = 'a2222222-2222-4222-8222-222222222222';
const MATCH_3 = 'a3333333-3333-4333-8333-333333333333';

describe('SupabaseUserStatisticsStore.getUserStatistics', () => {
  it('cuenta vistos, calificaciones y comentarios propios', async () => {
    const fake = makeFakeClient({
      tables: {
        watched_matches: [
          { user_id: USER_ID, match_id: MATCH_1 },
          { user_id: USER_ID, match_id: MATCH_2 },
          { user_id: USER_ID, match_id: MATCH_3 },
        ],
        match_ratings: [
          { user_id: USER_ID, match_id: MATCH_1 },
          { user_id: USER_ID, match_id: MATCH_2 },
        ],
        room_comments: [
          { author_id: USER_ID, id: 'c1' },
          { author_id: USER_ID, id: 'c2' },
          { author_id: USER_ID, id: 'c3' },
          { author_id: USER_ID, id: 'c4' },
        ],
      },
    });
    const store = new SupabaseUserStatisticsStore(asClient(fake));

    expect(await store.getUserStatistics(USER_ID)).toEqual({
      watchedMatches: 3,
      ratings: 2,
      comments: 4,
    });
  });

  it('filtra cada tabla por su columna de usuario y cuenta sin traer filas', async () => {
    const fake = makeFakeClient();
    const store = new SupabaseUserStatisticsStore(asClient(fake));

    await store.getUserStatistics(USER_ID);

    const calls = fake.from.mock.calls.map(([table], i) => {
      const builder = fake.from.mock.results[i]!.value as {
        select: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
      };
      return {
        table,
        select: builder.select.mock.calls[0],
        eq: builder.eq.mock.calls[0],
      };
    });

    expect(calls).toEqual([
      {
        table: 'watched_matches',
        select: ['*', { count: 'exact', head: true }],
        eq: ['user_id', USER_ID],
      },
      {
        table: 'match_ratings',
        select: ['*', { count: 'exact', head: true }],
        eq: ['user_id', USER_ID],
      },
      {
        table: 'room_comments',
        select: ['*', { count: 'exact', head: true }],
        eq: ['author_id', USER_ID],
      },
    ]);
  });

  it('no cuenta la actividad de otro usuario', async () => {
    const fake = makeFakeClient({
      tables: {
        watched_matches: [{ user_id: OTHER_USER_ID, match_id: MATCH_1 }],
        match_ratings: [{ user_id: OTHER_USER_ID, match_id: MATCH_1 }],
        room_comments: [{ author_id: OTHER_USER_ID, id: 'c1' }],
      },
    });
    const store = new SupabaseUserStatisticsStore(asClient(fake));

    expect(await store.getUserStatistics(USER_ID)).toEqual({
      watchedMatches: 0,
      ratings: 0,
      comments: 0,
    });
  });

  it('sin actividad devuelve ceros', async () => {
    const store = new SupabaseUserStatisticsStore(asClient(makeFakeClient()));

    expect(await store.getUserStatistics(USER_ID)).toEqual({
      watchedMatches: 0,
      ratings: 0,
      comments: 0,
    });
  });

  it.each(['watched_matches', 'match_ratings', 'room_comments'])(
    'un fallo al contar %s lanza el error de persistencia, no devuelve cero',
    async (table) => {
      const store = new SupabaseUserStatisticsStore(
        asClient(makeFakeClient({ errors: { [table]: { message: 'timeout de Postgres' } } })),
      );

      const failure = store.getUserStatistics(USER_ID);

      await expect(failure).rejects.toBeInstanceOf(UserStatisticsPersistenceError);
      await expect(failure).rejects.not.toThrow(/timeout de Postgres/);
    },
  );

  it('conserva el error original en cause', async () => {
    const original = { message: 'timeout de Postgres' };
    const store = new SupabaseUserStatisticsStore(
      asClient(makeFakeClient({ errors: { match_ratings: original } })),
    );

    const error = await store.getUserStatistics(USER_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UserStatisticsPersistenceError);
    expect((error as Error).cause).toBe(original);
  });

  it.each<[string, unknown]>([
    ['nulo', null],
    ['negativo', -1],
    ['decimal', 1.5],
    ['texto', '3'],
  ])('un conteo %s sin error se trata como fallo, no como cero', async (_, count) => {
    const store = new SupabaseUserStatisticsStore(
      asClient(makeFakeClient({ counts: { room_comments: count } })),
    );

    await expect(store.getUserStatistics(USER_ID)).rejects.toBeInstanceOf(
      UserStatisticsPersistenceError,
    );
  });
});
