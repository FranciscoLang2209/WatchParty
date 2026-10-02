import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Match } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import { SupabaseWatchedMatchStore } from './supabase-watched-match-store.js';
import { WatchedMatchPersistenceError } from './watched-match-persistence-error.js';

interface WatchedMatchRow {
  user_id: string;
  match_id: string;
}

type FakeError = { message: string };

interface FakeWatchedMatchesOptions {
  rows?: WatchedMatchRow[];
  upsertError?: FakeError;
  deleteError?: FakeError;
}

/**
 * Doble de Supabase con `watched_matches` en memoria: upsert respeta la PK
 * compuesta (ignora duplicados, no la pisa) y delete filtra por ambas
 * columnas, igual que hace la base real.
 */
function makeFakeClient(options: FakeWatchedMatchesOptions = {}) {
  const rows = [...(options.rows ?? [])];

  const from = vi.fn((table: string) => {
    if (table !== 'watched_matches') {
      throw new Error(`Tabla inesperada en el fake client: ${table}`);
    }

    const filters: Record<string, string> = {};

    const builder = {
      upsert: vi.fn(async (row: WatchedMatchRow) => {
        if (options.upsertError) return { data: null, error: options.upsertError };

        const exists = rows.some(
          (existing) => existing.user_id === row.user_id && existing.match_id === row.match_id,
        );
        if (!exists) rows.push(row);

        return { data: null, error: null };
      }),
      delete: vi.fn(() => builder),
      eq: vi.fn((column: string, value: string) => {
        filters[column] = value;
        return builder;
      }),
      then: (resolve: (value: { data: null; error: FakeError | null }) => unknown) => {
        if (options.deleteError) return resolve({ data: null, error: options.deleteError });

        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i];
          if (!row) continue;
          const matches = Object.entries(filters).every(
            ([column, value]) => row[column as keyof WatchedMatchRow] === value,
          );
          if (matches) rows.splice(i, 1);
        }

        return resolve({ data: null, error: null });
      },
    };

    return builder;
  });

  return { from, rows };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

const MATCH_ID = 'a1111111-1111-1111-1111-111111111111';
const UNKNOWN_MATCH_ID = 'b2222222-2222-2222-2222-222222222222';
const USER_ID = 'u1111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = 'u2222222-2222-2222-2222-222222222222';

function makeCatalog(): MatchCatalog {
  const match: Match = {
    id: MATCH_ID,
    homeTeam: 'Boca Juniors',
    homeTeamId: 'team-boca-juniors',
    awayTeam: 'River Plate',
    awayTeamId: 'team-river-plate',
    kickoffAt: '2026-09-20T21:00:00.000Z',
    status: 'scheduled',
  };

  return {
    list: async () => [match],
    findById: async (id) => (id === MATCH_ID ? match : null),
  };
}

describe('SupabaseWatchedMatchStore.setWatched()', () => {
  it('marca un partido visto y devuelve watched: true', async () => {
    const client = makeFakeClient();
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    const result = await store.setWatched(USER_ID, MATCH_ID, true);

    expect(result).toEqual({ matchId: MATCH_ID, watched: true });
    expect(client.rows).toEqual([{ user_id: USER_ID, match_id: MATCH_ID }]);
  });

  it('marcar dos veces el mismo partido deja una sola fila y watched: true', async () => {
    const client = makeFakeClient();
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    await store.setWatched(USER_ID, MATCH_ID, true);
    const second = await store.setWatched(USER_ID, MATCH_ID, true);

    expect(second).toEqual({ matchId: MATCH_ID, watched: true });
    expect(client.rows).toHaveLength(1);
  });

  it('deshacer borra la fila y devuelve watched: false', async () => {
    const client = makeFakeClient({ rows: [{ user_id: USER_ID, match_id: MATCH_ID }] });
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    const result = await store.setWatched(USER_ID, MATCH_ID, false);

    expect(result).toEqual({ matchId: MATCH_ID, watched: false });
    expect(client.rows).toHaveLength(0);
  });

  it('deshacer dos veces deja cero filas y watched: false, sin error', async () => {
    const client = makeFakeClient();
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    await store.setWatched(USER_ID, MATCH_ID, false);
    const second = await store.setWatched(USER_ID, MATCH_ID, false);

    expect(second).toEqual({ matchId: MATCH_ID, watched: false });
    expect(client.rows).toHaveLength(0);
  });

  it('deshacer no elimina el registro equivalente de otro usuario', async () => {
    const client = makeFakeClient({
      rows: [
        { user_id: USER_ID, match_id: MATCH_ID },
        { user_id: OTHER_USER_ID, match_id: MATCH_ID },
      ],
    });
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    await store.setWatched(USER_ID, MATCH_ID, false);

    expect(client.rows).toEqual([{ user_id: OTHER_USER_ID, match_id: MATCH_ID }]);
  });

  it('un matchId inexistente no crea fila y se informa como ausencia de dominio, al marcar', async () => {
    const client = makeFakeClient();
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    const result = await store.setWatched(USER_ID, UNKNOWN_MATCH_ID, true);

    expect(result).toBeNull();
    expect(client.rows).toHaveLength(0);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('un matchId inexistente se informa como ausencia de dominio, al deshacer', async () => {
    const client = makeFakeClient();
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    const result = await store.setWatched(USER_ID, UNKNOWN_MATCH_ID, false);

    expect(result).toBeNull();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('propaga un error de Supabase al marcar como WatchedMatchPersistenceError', async () => {
    const client = makeFakeClient({ upsertError: { message: 'fallo simulado' } });
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    await expect(store.setWatched(USER_ID, MATCH_ID, true)).rejects.toThrow(
      WatchedMatchPersistenceError,
    );
  });

  it('propaga un error de Supabase al deshacer como WatchedMatchPersistenceError', async () => {
    const client = makeFakeClient({ deleteError: { message: 'fallo simulado' } });
    const store = new SupabaseWatchedMatchStore(asSupabaseClient(client), makeCatalog());

    await expect(store.setWatched(USER_ID, MATCH_ID, false)).rejects.toThrow(
      WatchedMatchPersistenceError,
    );
  });
});
