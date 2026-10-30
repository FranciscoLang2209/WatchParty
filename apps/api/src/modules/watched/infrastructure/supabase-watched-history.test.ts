import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type {
  WatchedHistoryCursor,
  WatchedHistoryItem,
  WatchedHistoryRatingStatus,
} from '../domain/watched-match-store.js';
import { SupabaseWatchedMatchStore } from './supabase-watched-match-store.js';
import { WatchedMatchPersistenceError } from './watched-match-persistence-error.js';

interface EmbeddedMatchRow {
  id: string;
  kickoff_at: string;
  status: string;
  home_score: number | null;
  away_score: number | null;
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

interface RatingRow {
  user_id: string;
  match_id: string;
  rating: unknown;
}

type FakeError = { message: string };

interface FakeClientOptions {
  selectError?: FakeError;
  ratings?: RatingRow[];
  ratingsError?: FakeError;
}

/**
 * Doble de `match_ratings`: interpreta solo lo que arma `listHistoryPage`
 * para las notas propias, `eq` por usuario e `in` por partidos de la página.
 */
function makeRatingsBuilder(ratings: RatingRow[], ratingsError?: FakeError) {
  const filters: ((row: RatingRow) => boolean)[] = [];

  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: keyof RatingRow, value: string) => {
      filters.push((row) => row[column] === value);
      return builder;
    }),
    in: vi.fn((column: keyof RatingRow, values: string[]) => {
      filters.push((row) => values.includes(row[column] as string));
      return builder;
    }),
    then: (resolve: (value: { data: RatingRow[] | null; error: FakeError | null }) => void) => {
      if (ratingsError) {
        resolve({ data: null, error: ratingsError });
        return;
      }
      resolve({
        data: ratings.filter((row) => filters.every((filter) => filter(row))),
        error: null,
      });
    },
  };

  return builder;
}

/**
 * Doble de Supabase con `watched_matches` en memoria (embebiendo su partido,
 * como el select con relación). Interpreta solo lo que arma
 * `listHistoryPage`: `eq` por usuario, el filtro `or` del cursor, el `or`
 * por equipo sobre el partido embebido, `in`/`not in` por partidos
 * calificados, `order` descendente por columnas y `limit`.
 *
 * Como PostgREST, un filtro sobre el partido embebido solo excluye vistos si
 * el select usa `!inner`; sin eso el doble falla en vez de filtrar, para que
 * un test no pase con una consulta que en la base real no filtraría.
 */
function makeFakeClient(rows: HistoryRow[], options: FakeClientOptions = {}) {
  const from = vi.fn((table: string) => {
    if (table === 'match_ratings') {
      return makeRatingsBuilder(options.ratings ?? [], options.ratingsError);
    }
    if (table !== 'watched_matches') {
      throw new Error(`Tabla inesperada en el fake client: ${table}`);
    }

    const filters: ((row: HistoryRow) => boolean)[] = [];
    const orderColumns: { column: keyof HistoryRow; ascending: boolean }[] = [];
    let limitCount: number | undefined;

    let innerJoin = false;

    const builder = {
      select: vi.fn((columns: string) => {
        innerJoin = /match:matches![a-z_]+!inner\(/.test(columns);
        return builder;
      }),
      eq: vi.fn((column: keyof HistoryRow, value: string) => {
        filters.push((row) => row[column] === value);
        return builder;
      }),
      in: vi.fn((column: keyof HistoryRow, values: string[]) => {
        filters.push((row) => values.includes(row[column] as string));
        return builder;
      }),
      not: vi.fn((column: keyof HistoryRow, operator: string, value: string) => {
        const list = /^\((.*)\)$/.exec(value);
        if (operator !== 'in' || !list) throw new Error(`Filtro not inesperado: ${value}`);
        const values = list[1]!.split(',');
        filters.push((row) => !values.includes(row[column] as string));
        return builder;
      }),
      or: vi.fn((filter: string, orOptions?: { referencedTable?: string }) => {
        if (orOptions?.referencedTable !== undefined) {
          const team = /^home_team_id\.eq\.(.+),away_team_id\.eq\.(.+)$/.exec(filter);
          if (orOptions.referencedTable !== 'match' || !team || team[1] !== team[2]) {
            throw new Error(`Filtro or embebido inesperado: ${filter}`);
          }
          if (!innerJoin) {
            throw new Error('Filtrar el partido embebido sin !inner no excluye vistos.');
          }
          const teamId = team[1];
          filters.push(
            (row) => row.match.home_team?.id === teamId || row.match.away_team?.id === teamId,
          );
          return builder;
        }

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
      home_score: 2,
      away_score: 1,
      home_team: { id: `home-${n}`, name: `Local ${n}` },
      away_team: { id: `away-${n}`, name: `Visitante ${n}` },
    },
  };
}

function teamId(n: number): string {
  return `b${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`;
}

function withTeams(historyRow: HistoryRow, home: number, away: number): HistoryRow {
  historyRow.match.home_team = { id: teamId(home), name: `Equipo ${home}` };
  historyRow.match.away_team = { id: teamId(away), name: `Equipo ${away}` };
  return historyRow;
}

function rating(userId: string, n: number, value: unknown): RatingRow {
  return { user_id: userId, match_id: matchId(n), rating: value };
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
          score: { home: 2, away: 1 },
        },
        watchedAt: '2026-10-10T12:00:00.123Z',
        rating: null,
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
    [
      'watchedAt con una fecha inexistente',
      { watchedAt: '2026-02-30T12:00:00Z', matchId: matchId(1) },
    ],
    [
      'watchedAt del 29/02 en año no bisiesto',
      { watchedAt: '2026-02-29T12:00:00.123456+00:00', matchId: matchId(1) },
    ],
    [
      'watchedAt con un offset imposible',
      { watchedAt: '2026-10-01T10:00:00+16:00', matchId: matchId(1) },
    ],
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
  it('incluye la nota propia de cada visto, o null si no lo calificó', async () => {
    const client = makeFakeClient(
      [
        row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
        row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
        row(USER_ID, 3, '2026-10-03T10:00:00.000000+00:00'),
      ],
      { ratings: [rating(USER_ID, 1, 5), rating(USER_ID, 3, 2)] },
    );
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10 });

    expect(page.items.map((item) => [item.match.id, item.rating])).toEqual([
      [matchId(3), 2],
      [matchId(2), null],
      [matchId(1), 5],
    ]);
  });

  it('no usa la nota de otro usuario sobre el mismo partido', async () => {
    const client = makeFakeClient(
      [
        row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
        row(OTHER_USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
      ],
      { ratings: [rating(OTHER_USER_ID, 1, 4)] },
    );
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10 });

    expect(page.items.map((item) => item.rating)).toEqual([null]);
  });

  it('lee las notas de toda la página en una sola consulta, solo de los partidos de esa página', async () => {
    const client = makeFakeClient(
      [
        row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
        row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
        row(USER_ID, 3, '2026-10-03T10:00:00.000000+00:00'),
      ],
      { ratings: [rating(USER_ID, 1, 3)] },
    );
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await store.listHistoryPage(USER_ID, { limit: 2 });

    const tables = client.from.mock.calls.map(([table]) => table);
    expect(tables).toEqual(['watched_matches', 'match_ratings']);
    const ratingsBuilder = client.from.mock.results[1]!.value as ReturnType<
      typeof makeRatingsBuilder
    >;
    expect(ratingsBuilder.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(ratingsBuilder.in).toHaveBeenCalledWith('match_id', [matchId(3), matchId(2)]);
  });

  it('una página vacía no consulta las notas', async () => {
    const client = makeFakeClient([]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await store.listHistoryPage(USER_ID, { limit: 10 });

    expect(client.from.mock.calls.map(([table]) => table)).toEqual(['watched_matches']);
  });

  it('propaga un error al leer las notas como WatchedMatchPersistenceError, no como null', async () => {
    const client = makeFakeClient([row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00')], {
      ratingsError: { message: 'fallo simulado' },
    });
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await expect(store.listHistoryPage(USER_ID, { limit: 2 })).rejects.toThrow(
      WatchedMatchPersistenceError,
    );
  });

  it.each([0, 6, 3.5, '4'])(
    'una nota guardada fuera de rango (%s) se informa como error de persistencia',
    async (value) => {
      const client = makeFakeClient([row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00')], {
        ratings: [rating(USER_ID, 1, value)],
      });
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

      await expect(store.listHistoryPage(USER_ID, { limit: 2 })).rejects.toThrow(
        WatchedMatchPersistenceError,
      );
    },
  );

  it('las notas acompañan a cada página sin alterar el orden ni el cursor', async () => {
    const client = makeFakeClient(
      [
        row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
        row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
        row(USER_ID, 3, '2026-10-02T10:00:00.000000+00:00'),
      ],
      { ratings: [rating(USER_ID, 1, 1), rating(USER_ID, 3, 4)] },
    );
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const first = await store.listHistoryPage(USER_ID, { limit: 2 });
    const second = await store.listHistoryPage(USER_ID, { limit: 2, before: first.nextCursor! });

    expect(first.items.map((item) => [item.match.id, item.rating])).toEqual([
      [matchId(3), 4],
      [matchId(2), null],
    ]);
    expect(first.nextCursor).toEqual({
      watchedAt: '2026-10-02T10:00:00.000000+00:00',
      matchId: matchId(2),
    });
    expect(second.items.map((item) => [item.match.id, item.rating])).toEqual([[matchId(1), 1]]);
    expect(second.nextCursor).toBeNull();
  });
  it('con teamId devuelve los vistos donde el equipo jugó de local o de visitante', async () => {
    const client = makeFakeClient([
      withTeams(row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'), 1, 2),
      withTeams(row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'), 3, 1),
      withTeams(row(USER_ID, 3, '2026-10-03T10:00:00.000000+00:00'), 2, 3),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10, teamId: teamId(1) });

    expect(ids(page.items)).toEqual([matchId(2), matchId(1)]);
    expect(page.nextCursor).toBeNull();
  });

  it('con teamId sin coincidencias devuelve una página vacía', async () => {
    const client = makeFakeClient([
      withTeams(row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'), 1, 2),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    expect(await store.listHistoryPage(USER_ID, { limit: 10, teamId: teamId(9) })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('filtra antes de paginar: encuentra coincidencias que estaban en páginas posteriores', async () => {
    const client = makeFakeClient([
      withTeams(row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'), 1, 2),
      withTeams(row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'), 3, 1),
      withTeams(row(USER_ID, 3, '2026-10-03T10:00:00.000000+00:00'), 2, 3),
      withTeams(row(USER_ID, 4, '2026-10-04T10:00:00.000000+00:00'), 2, 3),
      withTeams(row(USER_ID, 5, '2026-10-05T10:00:00.000000+00:00'), 3, 2),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const first = await store.listHistoryPage(USER_ID, { limit: 1, teamId: teamId(1) });
    const second = await store.listHistoryPage(USER_ID, {
      limit: 1,
      teamId: teamId(1),
      before: first.nextCursor!,
    });

    expect(ids(first.items)).toEqual([matchId(2)]);
    expect(first.nextCursor).not.toBeNull();
    expect(ids(second.items)).toEqual([matchId(1)]);
    expect(second.nextCursor).toBeNull();
  });

  it('con teamId no incluye vistos de otro usuario del mismo equipo', async () => {
    const client = makeFakeClient([
      withTeams(row(OTHER_USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'), 1, 2),
    ]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    const page = await store.listHistoryPage(USER_ID, { limit: 10, teamId: teamId(1) });

    expect(page.items).toEqual([]);
  });

  it('sin teamId no filtra por equipo ni fuerza el join interno', async () => {
    const client = makeFakeClient([row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00')]);
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

    await store.listHistoryPage(USER_ID, { limit: 10 });

    const builder = client.from.mock.results[0]!.value as {
      select: { mock: { calls: string[][] } };
    };
    expect(builder.select.mock.calls[0]![0]).not.toContain('!inner');
  });

  it.each(['equipo-1', '', `${'b0000001-1111-4111-8111-111111111111'},user_id.neq.x`])(
    'con teamId inválido (%s) lanza RangeError sin consultar la base',
    async (invalid) => {
      const client = makeFakeClient([]);
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

      await expect(store.listHistoryPage(USER_ID, { limit: 2, teamId: invalid })).rejects.toThrow(
        RangeError,
      );
      expect(client.from).not.toHaveBeenCalled();
    },
  );
  describe('con ratingStatus', () => {
    // Vistos 1..5 del usuario; calificó 2 y 4. El otro usuario calificó 1.
    function ratedFixture() {
      return makeFakeClient(
        [
          withTeams(row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'), 1, 2),
          withTeams(row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'), 2, 3),
          withTeams(row(USER_ID, 3, '2026-10-03T10:00:00.000000+00:00'), 3, 1),
          withTeams(row(USER_ID, 4, '2026-10-04T10:00:00.000000+00:00'), 1, 3),
          withTeams(row(USER_ID, 5, '2026-10-05T10:00:00.000000+00:00'), 2, 3),
          withTeams(row(OTHER_USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'), 1, 2),
        ],
        {
          ratings: [rating(USER_ID, 2, 3), rating(USER_ID, 4, 5), rating(OTHER_USER_ID, 1, 4)],
        },
      );
    }

    it.each([undefined, 'all'] as const)(
      'con %s devuelve todo el historial propio, calificado o no',
      async (ratingStatus) => {
        const store = new SupabaseWatchedMatchStore(
          asSupabaseClient(ratedFixture()),
          unusedCatalog,
        );

        const page = await store.listHistoryPage(USER_ID, { limit: 10, ratingStatus });

        expect(ids(page.items)).toEqual([5, 4, 3, 2, 1].map(matchId));
      },
    );

    it('rated devuelve solo los vistos con nota propia', async () => {
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(ratedFixture()), unusedCatalog);

      const page = await store.listHistoryPage(USER_ID, { limit: 10, ratingStatus: 'rated' });

      expect(page.items.map((item) => [item.match.id, item.rating])).toEqual([
        [matchId(4), 5],
        [matchId(2), 3],
      ]);
    });

    it('unrated devuelve solo los vistos sin nota propia; la nota de otro usuario no cuenta', async () => {
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(ratedFixture()), unusedCatalog);

      const page = await store.listHistoryPage(USER_ID, { limit: 10, ratingStatus: 'unrated' });

      expect(page.items.map((item) => [item.match.id, item.rating])).toEqual([
        [matchId(5), null],
        [matchId(3), null],
        [matchId(1), null],
      ]);
    });

    it('se combina con teamId', async () => {
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(ratedFixture()), unusedCatalog);

      const rated = await store.listHistoryPage(USER_ID, {
        limit: 10,
        teamId: teamId(1),
        ratingStatus: 'rated',
      });
      const unrated = await store.listHistoryPage(USER_ID, {
        limit: 10,
        teamId: teamId(1),
        ratingStatus: 'unrated',
      });

      expect(ids(rated.items)).toEqual([matchId(4)]);
      expect(ids(unrated.items)).toEqual([matchId(3), matchId(1)]);
    });

    it.each(['rated', 'unrated'] as const)(
      '%s recorre páginas sucesivas sin duplicados ni huecos',
      async (ratingStatus) => {
        const store = new SupabaseWatchedMatchStore(
          asSupabaseClient(ratedFixture()),
          unusedCatalog,
        );
        const seen: string[] = [];
        let before: WatchedHistoryCursor | undefined;

        for (let pages = 0; pages < 10; pages++) {
          const page = await store.listHistoryPage(USER_ID, { limit: 1, ratingStatus, before });
          seen.push(...ids(page.items));
          if (!page.nextCursor) break;
          before = page.nextCursor;
        }

        expect(seen).toEqual(
          ratingStatus === 'rated' ? [matchId(4), matchId(2)] : [5, 3, 1].map(matchId),
        );
      },
    );

    it('rated sin ninguna nota propia devuelve vacío real sin listar los vistos', async () => {
      const client = makeFakeClient([row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00')], {
        ratings: [rating(OTHER_USER_ID, 1, 4)],
      });
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

      expect(await store.listHistoryPage(USER_ID, { limit: 10, ratingStatus: 'rated' })).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(client.from.mock.calls.map(([table]) => table)).toEqual(['match_ratings']);
    });

    it('unrated sin ninguna nota propia devuelve todo el historial', async () => {
      const client = makeFakeClient([
        row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00'),
        row(USER_ID, 2, '2026-10-02T10:00:00.000000+00:00'),
      ]);
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

      const page = await store.listHistoryPage(USER_ID, { limit: 10, ratingStatus: 'unrated' });

      expect(ids(page.items)).toEqual([matchId(2), matchId(1)]);
    });

    it('sin ratingStatus no consulta las notas antes de listar', async () => {
      const client = ratedFixture();
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

      await store.listHistoryPage(USER_ID, { limit: 10, ratingStatus: 'all' });

      expect(client.from.mock.calls.map(([table]) => table)).toEqual([
        'watched_matches',
        'match_ratings',
      ]);
    });

    it('propaga un error al leer las notas propias como WatchedMatchPersistenceError', async () => {
      const client = makeFakeClient([row(USER_ID, 1, '2026-10-01T10:00:00.000000+00:00')], {
        ratingsError: { message: 'fallo simulado' },
      });
      const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

      await expect(
        store.listHistoryPage(USER_ID, { limit: 2, ratingStatus: 'unrated' }),
      ).rejects.toThrow(WatchedMatchPersistenceError);
    });

    it.each(['RATED', 'none', ''])(
      'con ratingStatus inválido (%s) lanza RangeError sin consultar la base',
      async (invalid) => {
        const client = makeFakeClient([]);
        const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), unusedCatalog);

        await expect(
          store.listHistoryPage(USER_ID, {
            limit: 2,
            ratingStatus: invalid as WatchedHistoryRatingStatus,
          }),
        ).rejects.toThrow(RangeError);
        expect(client.from).not.toHaveBeenCalled();
      },
    );
  });
});
