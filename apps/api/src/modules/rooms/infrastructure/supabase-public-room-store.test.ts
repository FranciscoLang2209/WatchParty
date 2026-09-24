import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Match } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import { SupabasePublicRoomStore } from './supabase-public-room-store.js';
import { RoomPersistenceError } from './room-persistence-error.js';

interface RoomRow {
  id: string;
  match_id: string;
  created_at: string;
}

type FakeError = { code?: string; message: string };

interface FakeRoomsOptions {
  rows?: RoomRow[];
  /** Simula otro pedido que crea la sala entre la lectura y la inserción. */
  concurrentRow?: RoomRow;
  selectError?: FakeError;
  insertError?: FakeError;
}

/**
 * Doble de Supabase con la tabla `rooms` en memoria, mismo criterio que
 * `supabase-own-profile-store.test.ts`: cada método de encadenado devuelve
 * el mismo builder. La inserción respeta `rooms_match_id_key` igual que la
 * base, así que las pruebas comprueban comportamiento y no llamadas.
 */
function makeFakeClient(options: FakeRoomsOptions = {}) {
  const rows = [...(options.rows ?? [])];
  let concurrentRow = options.concurrentRow;
  let insertCount = 0;

  const from = vi.fn((table: string) => {
    if (table !== 'rooms') {
      throw new Error(`Tabla inesperada en el fake client: ${table}`);
    }

    const filters: Record<string, string> = {};
    let pendingInsert: { match_id: string } | undefined;

    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: string) => {
        filters[column] = value;
        return builder;
      }),
      insert: vi.fn((row: { match_id: string }) => {
        pendingInsert = row;
        return builder;
      }),
      maybeSingle: vi.fn(async () => {
        if (options.selectError) return { data: null, error: options.selectError };

        const found = rows.find((row) =>
          Object.entries(filters).every(
            ([column, value]) => row[column as keyof RoomRow] === value,
          ),
        );
        return { data: found ?? null, error: null };
      }),
      single: vi.fn(async () => {
        if (!pendingInsert) throw new Error('single() sin insert() previo');
        if (options.insertError) return { data: null, error: options.insertError };

        if (concurrentRow) {
          rows.push(concurrentRow);
          concurrentRow = undefined;
        }

        const matchId = pendingInsert.match_id;
        if (rows.some((row) => row.match_id === matchId)) {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "rooms_match_id_key"',
            },
          };
        }

        insertCount += 1;
        const row: RoomRow = {
          id: `c0000000-0000-0000-0000-00000000000${insertCount}`,
          match_id: matchId,
          created_at: '2026-09-18T21:00:00.123456+00:00',
        };
        rows.push(row);
        return { data: row, error: null };
      }),
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

const EXISTING_ROW: RoomRow = {
  id: 'd4444444-4444-4444-4444-444444444444',
  match_id: MATCH_ID,
  created_at: '2026-09-17T12:00:00+00:00',
};

function makeCatalog(): MatchCatalog {
  const match: Match = {
    id: MATCH_ID,
    homeTeam: 'Boca Juniors',
    awayTeam: 'River Plate',
    kickoffAt: '2026-09-20T21:00:00.000Z',
    status: 'scheduled',
  };

  return {
    list: async () => [match],
    findById: async (id) => (id === MATCH_ID ? match : null),
  };
}

describe('SupabasePublicRoomStore.getOrCreatePublicRoom()', () => {
  it('crea la sala cuando el partido todavía no tiene una y expone solo id, matchId y createdAt', async () => {
    const client = makeFakeClient();
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const room = await store.getOrCreatePublicRoom(MATCH_ID);

    expect(room).toEqual({
      id: 'c0000000-0000-0000-0000-000000000001',
      matchId: MATCH_ID,
      createdAt: '2026-09-18T21:00:00.123Z',
    });
    expect(client.rows).toHaveLength(1);
  });

  it('dos llamadas para el mismo partido devuelven el mismo id y guardan una sola fila', async () => {
    const client = makeFakeClient();
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const first = await store.getOrCreatePublicRoom(MATCH_ID);
    const second = await store.getOrCreatePublicRoom(MATCH_ID);

    expect(second?.id).toBe(first?.id);
    expect(client.rows).toHaveLength(1);
  });

  it('devuelve la sala existente sin crear otra', async () => {
    const client = makeFakeClient({ rows: [EXISTING_ROW] });
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const room = await store.getOrCreatePublicRoom(MATCH_ID);

    expect(room).toEqual({
      id: EXISTING_ROW.id,
      matchId: MATCH_ID,
      createdAt: '2026-09-17T12:00:00.000Z',
    });
    expect(client.rows).toEqual([EXISTING_ROW]);
  });

  it('devuelve null para un partido inexistente sin tocar la tabla rooms', async () => {
    const client = makeFakeClient();
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    await expect(store.getOrCreatePublicRoom(UNKNOWN_MATCH_ID)).resolves.toBeNull();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rows).toHaveLength(0);
  });

  it('si otro pedido crea la sala a la vez, devuelve esa sala en vez de fallar', async () => {
    const client = makeFakeClient({ concurrentRow: EXISTING_ROW });
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const room = await store.getOrCreatePublicRoom(MATCH_ID);

    expect(room?.id).toBe(EXISTING_ROW.id);
    expect(client.rows).toEqual([EXISTING_ROW]);
  });

  it('propaga un error de lectura como RoomPersistenceError sanitizado', async () => {
    const client = makeFakeClient({
      selectError: { message: 'conexión perdida a public.rooms' },
    });
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const rejection = expect(store.getOrCreatePublicRoom(MATCH_ID)).rejects;
    await rejection.toThrow(RoomPersistenceError);
    await rejection.not.toThrow('conexión perdida a public.rooms');
  });

  it('propaga un error de inserción distinto de la colisión como RoomPersistenceError', async () => {
    const client = makeFakeClient({
      insertError: {
        code: '23503',
        message: 'insert or update on table "rooms" violates foreign key',
      },
    });
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const rejection = expect(store.getOrCreatePublicRoom(MATCH_ID)).rejects;
    await rejection.toThrow(RoomPersistenceError);
    await rejection.not.toThrow('violates foreign key');
  });
});

describe('SupabasePublicRoomStore.findPublicRoomById()', () => {
  it('devuelve la sala con ese id', async () => {
    const client = makeFakeClient({ rows: [EXISTING_ROW] });
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    await expect(store.findPublicRoomById(EXISTING_ROW.id)).resolves.toEqual({
      id: EXISTING_ROW.id,
      matchId: MATCH_ID,
      createdAt: '2026-09-17T12:00:00.000Z',
    });
  });

  it('devuelve null para una sala inexistente sin crear ninguna', async () => {
    const client = makeFakeClient();
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    await expect(store.findPublicRoomById(EXISTING_ROW.id)).resolves.toBeNull();
    expect(client.rows).toHaveLength(0);
  });

  it('propaga un error de lectura como RoomPersistenceError sanitizado', async () => {
    const client = makeFakeClient({
      selectError: { message: 'conexión perdida a public.rooms' },
    });
    const store = new SupabasePublicRoomStore(asSupabaseClient(client), makeCatalog());

    const rejection = expect(store.findPublicRoomById(EXISTING_ROW.id)).rejects;
    await rejection.toThrow(RoomPersistenceError);
    await rejection.not.toThrow('conexión perdida a public.rooms');
  });
});
