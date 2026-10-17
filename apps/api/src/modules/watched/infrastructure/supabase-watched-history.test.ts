import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { WatchedHistoryItem } from '../domain/watched-match-store.js';
import { SupabaseWatchedMatchStore } from './supabase-watched-match-store.js';
import { WatchedMatchPersistenceError } from './watched-match-persistence-error.js';

interface EmbeddedMatchRow {
  id: string;
  kickoff_at: string;
  status: string;
  home_team: { id: string; name: string } | null;
  away_team: { id: string; name: string } | null;
}

interface HistoryRow {
  user_id: string;
  match_id: string;
  /** Mismo formato de PostgREST con microsegundos: comparable como texto. */
  created_at: string;
  match: EmbeddedMatchRow;
}

type FakeError = { message: string };

/**
 * Doble de Supabase con `watched_matches` en memoria (embebiendo su partido,
 * como el select con relación). Interpreta solo lo que arma
 * `listHistoryPage`: `eq` por usuario, el filtro `or` del cursor, `order`
 * descendente por columnas y `limit`.
 */
function makeFakeClient(rows: HistoryRow[], options: { selectError?: FakeError } = {}) {
  const from = vi.fn((table: string) => {
    if (table !== 'watched_matches') {
      throw new Error(`Tabla inesperada en el fake client: ${table}`);
    }

    const filters: ((row: HistoryRow) => boolean)[] = [];
    const orderColumns: { column: keyof HistoryRow; ascending: boolean }[] = [];
    let limitCount: number | undefined;

    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: keyof HistoryRow, value: string) => {
        filters.push((row) => row[column] === value);
        return builder;
      }),
      or: vi.fn((filter: string) => {
        const match = /^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),match_id\.lt\.(.+)\)$/.exec(
          filter,
        );
        if (!match) throw new Error(`Filtro or inesperado: ${filter}`);
        const [, lt, eq, matchId] = match as unknown as [string, string, string, string];
        filters.push(
          (row) => row.created_at < lt || (row.created_at === eq && row.match_id < matchId),
        );
        return builder;
      }),
      order: vi.fn((column: keyof HistoryRow, { ascending }: { ascending: boolean }) => {
        orderColumns.push({ column, ascending });
        return builder;
      }),
      limit: vi.fn((count: number) => {
        limitCount = count;
        return builder;
      }),
      then: (resolve: (value: { data: HistoryRow[] | null; error: FakeError | null }) => void) => {
        if (options.selectError) {
          resolve({ data: null, error: options.selectError });
          return;
        }

        const sorted = rows
          .filter((row) => filters.every((filter) => filter(row)))
          .sort((a, b) => {
            for (const { column, ascending } of orderColumns) {
              const left = String(a[column]);
              const right = String(b[column]);
              if (left !== right) return (left < right ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });

        resolve({
          data: limitCount === undefined ? sorted : sorted.slice(0, limitCount),
          error: null,
        });
      },
    };

    return builder;
  });

  return { from };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

const USER_ID = 'c1111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = 'c2222222-2222-4222-8222-222222222222';

// El historial no consulta el catálogo partido por partido: viene embebido.
const unusedCatalog: MatchCatalog = {
  list: async () => [],
  findById: async () => {
    throw new Error('listHistoryPage no debería consultar el catálogo por id');
  },
};

function matchId(n: number): string {
  return `a${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`;
}

function row(userId: string, n: number, createdAt: string, status = 'finished'): HistoryRow {
  return {
    user_id: userId,
    match_id: matchId(n),
    created_at: createdAt,
    match: {
      id: matchId(n),
      kickoff_at: '2026-10-05T21:00:00+00:00',
      status,
      home_team: { id: `home-${n}`, name: `Local ${n}` },
      away_team: { id: `away-${n}`, name: `Visitante ${n}` },
    },
  };
}

function ids(items: WatchedHistoryItem[]): string[] {
  return items.map((item) => item.match.id);
}

describe('SupabaseWatchedMatchStore.listHistoryPage()', () => {
  it('un usuario sin vistos recibe una página vacía, no null', async () => {
    const client = makeFakeClient([row(OTHER_USER_ID, 1, '2026-10-10T12:00:00.000001+00:00')]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    expect(await store.listHistoryPage(USER_ID, { limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('devuelve el partido con equipos, fecha, estado y el momento en que se marcó visto', async () => {
    const client = makeFakeClient([row(USER_ID, 1, '2026-10-10T12:00:00.123456+00:00')]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10 });

    expect(page.items).toEqual([
      {
        match: {
          id: matchId(1),
          homeTeam: 'Local 1',
          homeTeamId: 'home-1',
          awayTeam: 'Visitante 1',
          awayTeamId: 'away-1',
          kickoffAt: '2026-10-05T21:00:00.000Z',
          status: 'finished',
        },
        watchedAt: '2026-10-10T12:00:00.123Z',
      },
    ]);
  });

  it('ordena del visto más reciente al más antiguo, con desempate estable por match_id', async () => {
    const client = makeFakeClient([
      row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
      row(USER_ID, 2, '2026-10-03T10:00:00.000000+00:00'),
      row(USER_ID, 3, '2026-10-02T10:00:00.000000+00:00'),
      row(USER_ID, 4, '2026-10-02T10:00:00.000000+00:00'),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10 });

    expect(ids(page.items)).toEqual([matchId(2), matchId(4), matchId(3), matchId(1)]);
  });

  it('no incluye vistos de otro usuario', async () => {
    const client = makeFakeClient([
      row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
      row(OTHER_USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10 });

    expect(ids(page.items)).toEqual([matchId(1)]);
  });

  it('recorre todas las páginas sin duplicados ni huecos, incluso con empates en el borde', async () => {
    const client = makeFakeClient([
      row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
      row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
      row(USER_ID, 3, '2026-10-02T10:00:00.000000+00:00'),
      row(USER_ID, 4, '2026-10-02T10:00:00.000000+00:00'),
      row(USER_ID, 5, '2026-10-03T10:00:00.000000+00:00'),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const first = await store.listHistoryPage(USER_ID, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listHistoryPage(USER_ID, {
      limit: 2,
      before: first.nextCursor!,
    });
    expect(second.nextCursor).not.toBeNull();
    const third = await store.listHistoryPage(USER_ID, {
      limit: 2,
      before: second.nextCursor!,
    });

    expect(ids(first.items)).toEqual([matchId(5), matchId(4)]);
    expect(ids(second.items)).toEqual([matchId(3), matchId(2)]);
    expect(ids(third.items)).toEqual([matchId(1)]);
    expect(third.nextCursor).toBeNull();
  });

  it('el cursor usa el created_at crudo con microsegundos, no el watchedAt truncado', async () => {
    const client = makeFakeClient([
      row(USER_ID, 1, '2026-10-01T10:00:00.123400+00:00'),
      row(USER_ID, 2, '2026-10-01T10:00:00.123456+00:00'),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const first = await store.listHistoryPage(USER_ID, { limit: 1 });
    const second = await store.listHistoryPage(USER_ID, { limit: 1, before: first.nextCursor! });

    expect(first.nextCursor).toEqual({
      watchedAt: '2026-10-01T10:00:00.123456+00:00',
      matchId: matchId(2),
    });
    expect(ids(second.items)).toEqual([matchId(1)]);
  });

  it('una página exacta (sin filas extra) no ofrece siguiente cursor', async () => {
    const client = makeFakeClient([
      row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
      row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it.each([0, -1, 1.5])('con limit %s lanza RangeError sin consultar la base', async (limit) => {
    const client = makeFakeClient([]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await expect(store.listHistoryPage(USER_ID, { limit })).rejects.toThrow(RangeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each([
    ['watchedAt mal formado', { watchedAt: 'ayer', matchId: matchId(1) }],
    [
      'watchedAt con un filtro inyectado',
      { watchedAt: '2026-10-01T10:00:00Z,user_id.neq.x', matchId: matchId(1) },
    ],
    ['matchId que no es UUID', { watchedAt: '2026-10-01T10:00:00Z', matchId: 'x)' }],
  ])('con cursor inválido (%s) lanza RangeError sin consultar la base', async (_label, before) => {
    const client = makeFakeClient([]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await expect(store.listHistoryPage(USER_ID, { limit: 2, before })).rejects.toThrow(RangeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('propaga un error de Supabase como WatchedMatchPersistenceError, no como lista vacía', async () => {
    const client = makeFakeClient([], { selectError: { message: 'fallo simulado' } });
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await expect(store.listHistoryPage(USER_ID, { limit: 2 })).rejects.toThrow(
      WatchedMatchPersistenceError,
    );
  });

  it('un partido embebido sin equipos se informa como error de persistencia', async () => {
    const broken = row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00');
    broken.match.home_team = null;
    const client = makeFakeClient([broken]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await expect(store.listHistoryPage(USER_ID, { limit: 2 })).rejects.toThrow();
  });
});
