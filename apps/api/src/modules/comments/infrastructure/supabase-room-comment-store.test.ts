import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseRoomCommentStore } from './supabase-room-comment-store.js';
import { RoomCommentPersistenceError } from './room-comment-persistence-error.js';

interface RoomRow {
  id: string;
}

interface RoomCommentRow {
  id: string;
  room_id: string;
  author_id: string;
  body: string;
  client_request_id: string;
  created_at: string;
}

type FakeError = { code?: string; message: string };

interface FakeClientOptions {
  rooms?: RoomRow[];
  comments?: RoomCommentRow[];
  roomsSelectError?: FakeError;
  commentsListError?: FakeError;
  commentsInsertError?: FakeError;
}

let nextCommentId = 0;

/**
 * Doble de Supabase con dos tablas en memoria (`rooms`, `room_comments`),
 * mismo criterio que `supabase-public-room-store.test.ts`: cada método
 * encadenado devuelve el mismo builder, y la unicidad de
 * `(author_id, client_request_id)` se respeta igual que en la base real —
 * las pruebas verifican comportamiento observable, no qué métodos internos
 * se llamaron.
 */
function makeFakeClient(options: FakeClientOptions = {}) {
  const rooms = [...(options.rooms ?? [])];
  const comments = [...(options.comments ?? [])];

  const from = vi.fn((table: string) => {
    if (table === 'rooms') {
      const filters: Record<string, string> = {};

      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          filters[column] = value;
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (options.roomsSelectError) {
            return { data: null, error: options.roomsSelectError };
          }

          const found = rooms.find((row) =>
            Object.entries(filters).every(
              ([column, value]) => row[column as keyof RoomRow] === value,
            ),
          );

          return { data: found ?? null, error: null };
        }),
      };

      return builder;
    }

    if (table === 'room_comments') {
      const filters: Record<string, string> = {};
      const orderColumns: (keyof RoomCommentRow)[] = [];
      let pendingInsert: Record<string, unknown> | undefined;
      let orPredicate: ((row: RoomCommentRow) => boolean) | undefined;
      let limitCount: number | undefined;

      function matching() {
        return comments.filter(
          (row) =>
            Object.entries(filters).every(
              ([column, value]) => row[column as keyof RoomCommentRow] === value,
            ) && (orPredicate ? orPredicate(row) : true),
        );
      }

      function sortedMatching() {
        return [...matching()].sort((a, b) => {
          for (const column of orderColumns) {
            if (a[column] < b[column]) return -1;
            if (a[column] > b[column]) return 1;
          }
          return 0;
        });
      }

      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          filters[column] = value;
          return builder;
        }),
        // Interpreta solo el filtro que arma `listPageByRoom` para el cursor:
        // (created_at, id) > (T, I). Si el formato cambia, el fake falla en
        // voz alta en vez de ignorar el filtro. Compara strings: todos los
        // created_at de las pruebas de paginación usan el mismo formato.
        or: vi.fn((filter: string) => {
          const match = filter.match(
            /^created_at\.gt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.gt\.([^,)]+)\)$/,
          );
          const [, createdAt, sameCreatedAt, id] = match ?? [];
          if (!createdAt || createdAt !== sameCreatedAt || !id) {
            throw new Error(`Filtro or() no soportado por el fake: ${filter}`);
          }
          orPredicate = (row) =>
            row.created_at > createdAt || (row.created_at === createdAt && row.id > id);
          return builder;
        }),
        limit: vi.fn((count: number) => {
          limitCount = count;
          return builder;
        }),
        order: vi.fn((column: string) => {
          orderColumns.push(column as keyof RoomCommentRow);
          return builder;
        }),
        insert: vi.fn((row: Record<string, unknown>) => {
          pendingInsert = row;
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          const [found] = matching();
          return { data: found ?? null, error: null };
        }),
        single: vi.fn(async () => {
          if (options.commentsInsertError) {
            return { data: null, error: options.commentsInsertError };
          }

          const insertRow = pendingInsert as {
            room_id: string;
            author_id: string;
            body: string;
            client_request_id: string;
          };

          const duplicate = comments.find(
            (row) =>
              row.author_id === insertRow.author_id &&
              row.client_request_id === insertRow.client_request_id,
          );

          if (duplicate) {
            return {
              data: null,
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint',
              },
            };
          }

          nextCommentId += 1;
          const newRow: RoomCommentRow = {
            id: `comment-${nextCommentId}`,
            room_id: insertRow.room_id,
            author_id: insertRow.author_id,
            body: insertRow.body,
            client_request_id: insertRow.client_request_id,
            created_at: new Date(2026, 0, 1, 0, 0, nextCommentId).toISOString(),
          };
          comments.push(newRow);

          return { data: newRow, error: null };
        }),
        // `listByRoom` nunca llama a un método terminal: hace
        // `await client.from(...).select(...).eq(...).order(...).order(...)`
        // directamente, igual que el query builder real de Supabase (que es
        // "thenable"). Replicamos eso acá.
        then: (
          resolve: (value: { data: RoomCommentRow[] | null; error: FakeError | null }) => void,
        ) => {
          if (options.commentsListError) {
            resolve({ data: null, error: options.commentsListError });
            return;
          }

          const sorted = sortedMatching();
          resolve({
            data: limitCount === undefined ? sorted : sorted.slice(0, limitCount),
            error: null,
          });
        },
      };

      return builder;
    }

    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  return { from } as unknown as SupabaseClient;
}

const ROOM_A = { id: 'room-a' };
const ROOM_B = { id: 'room-b' };

// IDs con forma de UUID: el cursor los valida antes de usarlos en el filtro.
const ID_1 = '00000000-0000-0000-0000-000000000001';
const ID_2 = '00000000-0000-0000-0000-000000000002';
const ID_3 = '00000000-0000-0000-0000-000000000003';
const ID_4 = '00000000-0000-0000-0000-000000000004';

/** Fila con `created_at` en el formato (con microsegundos) que devuelve Postgres. */
function pagedRow(id: string, createdAt: string, roomId = 'room-a'): RoomCommentRow {
  return {
    id,
    room_id: roomId,
    author_id: AUTHOR,
    body: `comentario ${id.slice(-1)}`,
    client_request_id: `req-${id}`,
    created_at: createdAt,
  };
}

const T1 = '2026-01-01T00:00:01.000000+00:00';
const T2 = '2026-01-01T00:00:02.000000+00:00';
const T3 = '2026-01-01T00:00:03.000000+00:00';
const AUTHOR = 'author-1';

describe('listPageByRoom', () => {
  it('devuelve null si la sala no existe', async () => {
    const store = new SupabaseRoomCommentStore(makeFakeClient({ rooms: [] }));

    expect(await store.listPageByRoom('sala-inexistente', { limit: 2 })).toBeNull();
  });

  it('con límite 2 y tres comentarios: la primera página trae 2 y un cursor no nulo', async () => {
    const client = makeFakeClient({
      rooms: [ROOM_A],
      comments: [pagedRow(ID_3, T3), pagedRow(ID_1, T1), pagedRow(ID_2, T2)],
    });
    const store = new SupabaseRoomCommentStore(client);

    const page = await store.listPageByRoom('room-a', { limit: 2 });

    expect(page?.items.map((item) => item.id)).toEqual([ID_1, ID_2]);
    expect(page?.nextCursor).toEqual({ createdAt: T2, id: ID_2 });
  });

  it('reutilizar el cursor devuelve solo el comentario restante y nextCursor null', async () => {
    const client = makeFakeClient({
      rooms: [ROOM_A],
      comments: [pagedRow(ID_1, T1), pagedRow(ID_2, T2), pagedRow(ID_3, T3)],
    });
    const store = new SupabaseRoomCommentStore(client);

    const first = await store.listPageByRoom('room-a', { limit: 2 });
    const second = await store.listPageByRoom('room-a', {
      limit: 2,
      after: first?.nextCursor ?? undefined,
    });

    expect(second?.items.map((item) => item.id)).toEqual([ID_3]);
    expect(second?.nextCursor).toBeNull();
  });

  it('nextCursor es null cuando la cantidad de comentarios es exactamente el límite', async () => {
    const client = makeFakeClient({
      rooms: [ROOM_A],
      comments: [pagedRow(ID_1, T1), pagedRow(ID_2, T2)],
    });
    const store = new SupabaseRoomCommentStore(client);

    const page = await store.listPageByRoom('room-a', { limit: 2 });

    expect(page?.items).toHaveLength(2);
    expect(page?.nextCursor).toBeNull();
  });

  it('devuelve una página vacía con nextCursor null si la sala no tiene comentarios', async () => {
    const store = new SupabaseRoomCommentStore(makeFakeClient({ rooms: [ROOM_A], comments: [] }));

    expect(await store.listPageByRoom('room-a', { limit: 2 })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('con la misma fecha y distinto id, cada comentario aparece una sola vez', async () => {
    const client = makeFakeClient({
      rooms: [ROOM_A],
      comments: [pagedRow(ID_3, T1), pagedRow(ID_1, T1), pagedRow(ID_2, T1)],
    });
    const store = new SupabaseRoomCommentStore(client);

    const seen: string[] = [];
    let after: { createdAt: string; id: string } | undefined;
    do {
      const page = await store.listPageByRoom('room-a', { limit: 1, after });
      seen.push(...(page?.items.map((item) => item.id) ?? []));
      after = page?.nextCursor ?? undefined;
    } while (after);

    expect(seen).toEqual([ID_1, ID_2, ID_3]);
  });

  it('no repite ni omite comentarios cuando difieren solo en microsegundos', async () => {
    // RoomComment.createdAt se trunca a milisegundos; el cursor debe usar el
    // created_at crudo. Si usara el truncado, ID_1 volvería a aparecer.
    const micro1 = '2026-01-01T00:00:01.123456+00:00';
    const micro2 = '2026-01-01T00:00:01.123789+00:00';
    const client = makeFakeClient({
      rooms: [ROOM_A],
      comments: [pagedRow(ID_1, micro1), pagedRow(ID_2, micro2), pagedRow(ID_3, T2)],
    });
    const store = new SupabaseRoomCommentStore(client);

    const first = await store.listPageByRoom('room-a', { limit: 1 });
    const second = await store.listPageByRoom('room-a', {
      limit: 1,
      after: first?.nextCursor ?? undefined,
    });

    expect(first?.items.map((item) => item.id)).toEqual([ID_1]);
    expect(first?.nextCursor).toEqual({ createdAt: micro1, id: ID_1 });
    expect(second?.items.map((item) => item.id)).toEqual([ID_2]);
  });

  it('un cursor nunca devuelve comentarios de otra sala', async () => {
    const client = makeFakeClient({
      rooms: [ROOM_A, ROOM_B],
      comments: [
        pagedRow(ID_1, T1, 'room-a'),
        pagedRow(ID_2, T2, 'room-a'),
        pagedRow(ID_3, T2, 'room-b'),
        pagedRow(ID_4, T3, 'room-b'),
      ],
    });
    const store = new SupabaseRoomCommentStore(client);

    const cursorFromRoomA = (await store.listPageByRoom('room-a', { limit: 1 }))?.nextCursor;
    const roomB = await store.listPageByRoom('room-b', {
      limit: 10,
      after: cursorFromRoomA ?? undefined,
    });

    expect(roomB?.items.map((item) => item.roomId)).toEqual(['room-b', 'room-b']);
    expect(roomB?.items.map((item) => item.id)).toEqual([ID_3, ID_4]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rechaza el límite inválido %s', async (limit) => {
    const store = new SupabaseRoomCommentStore(makeFakeClient({ rooms: [ROOM_A] }));

    await expect(store.listPageByRoom('room-a', { limit })).rejects.toThrow(RangeError);
  });

  it.each([
    { createdAt: 'no-es-una-fecha', id: ID_1 },
    { createdAt: T1, id: 'no-es-un-uuid' },
    { createdAt: `${T1},id.neq.${ID_2}`, id: ID_1 },
  ])('rechaza un cursor malformado antes de consultar: %j', async (after) => {
    const client = makeFakeClient({ rooms: [ROOM_A] });
    const store = new SupabaseRoomCommentStore(client);

    await expect(store.listPageByRoom('room-a', { limit: 2, after })).rejects.toThrow(RangeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('lanza RoomCommentPersistenceError si Supabase falla al listar la página', async () => {
    const client = makeFakeClient({
      rooms: [ROOM_A],
      commentsListError: { message: 'boom' },
    });
    const store = new SupabaseRoomCommentStore(client);

    await expect(store.listPageByRoom('room-a', { limit: 2 })).rejects.toThrow(
      RoomCommentPersistenceError,
    );
  });
});
describe('SupabaseRoomCommentStore', () => {
  describe('listByRoom', () => {
    it('devuelve null si la sala no existe', async () => {
      const client = makeFakeClient({ rooms: [] });
      const store = new SupabaseRoomCommentStore(client);

      const result = await store.listByRoom('sala-inexistente');

      expect(result).toBeNull();
    });

    it('trata un roomId con formato inválido como sala inexistente (no lanza)', async () => {
      const client = makeFakeClient({
        rooms: [],
        roomsSelectError: { code: '22P02', message: 'invalid input syntax for type uuid' },
      });
      const store = new SupabaseRoomCommentStore(client);

      const result = await store.listByRoom('no-es-un-uuid');

      expect(result).toBeNull();
    });

    it('devuelve los comentarios de la sala ordenados por created_at, id', async () => {
      const client = makeFakeClient({
        rooms: [ROOM_A],
        comments: [
          {
            id: 'c2',
            room_id: 'room-a',
            author_id: AUTHOR,
            body: 'segundo',
            client_request_id: 'req-2',
            created_at: '2026-01-01T00:00:02.000Z',
          },
          {
            id: 'c1',
            room_id: 'room-a',
            author_id: AUTHOR,
            body: 'primero',
            client_request_id: 'req-1',
            created_at: '2026-01-01T00:00:01.000Z',
          },
        ],
      });
      const store = new SupabaseRoomCommentStore(client);

      const result = await store.listByRoom('room-a');

      expect(result).toEqual([
        expect.objectContaining({ id: 'c1', body: 'primero' }),
        expect.objectContaining({ id: 'c2', body: 'segundo' }),
      ]);
    });

    it('devuelve [] si la sala existe pero todavía no tiene comentarios', async () => {
      const client = makeFakeClient({ rooms: [ROOM_A], comments: [] });
      const store = new SupabaseRoomCommentStore(client);

      const result = await store.listByRoom('room-a');

      expect(result).toEqual([]);
    });

    it('lanza RoomCommentPersistenceError si Supabase falla al listar', async () => {
      const client = makeFakeClient({
        rooms: [ROOM_A],
        commentsListError: { message: 'boom' },
      });
      const store = new SupabaseRoomCommentStore(client);

      await expect(store.listByRoom('room-a')).rejects.toThrow(RoomCommentPersistenceError);
    });
  });

  describe('create', () => {
    it('devuelve null y no inserta nada si la sala no existe', async () => {
      const client = makeFakeClient({ rooms: [], comments: [] });
      const store = new SupabaseRoomCommentStore(client);

      const result = await store.create(
        { roomId: 'sala-inexistente', body: 'hola', clientRequestId: 'req-1' },
        AUTHOR,
      );

      expect(result).toBeNull();
    });

    it('crea el comentario cuando la sala existe', async () => {
      const client = makeFakeClient({ rooms: [ROOM_A], comments: [] });
      const store = new SupabaseRoomCommentStore(client);

      const result = await store.create(
        { roomId: 'room-a', body: 'hola', clientRequestId: 'req-1' },
        AUTHOR,
      );

      expect(result).toEqual(expect.objectContaining({ roomId: 'room-a', body: 'hola' }));
    });

    it('dos creaciones con el mismo clientRequestId devuelven un único comentario', async () => {
      const client = makeFakeClient({ rooms: [ROOM_A], comments: [] });
      const store = new SupabaseRoomCommentStore(client);

      const first = await store.create(
        { roomId: 'room-a', body: 'hola', clientRequestId: 'req-1' },
        AUTHOR,
      );
      const second = await store.create(
        { roomId: 'room-a', body: 'hola', clientRequestId: 'req-1' },
        AUTHOR,
      );

      expect(first).not.toBeNull();
      expect(second).toEqual(first);

      const all = await store.listByRoom('room-a');
      expect(all).toHaveLength(1);
    });

    it('lanza RoomCommentPersistenceError si Supabase falla al crear', async () => {
      const client = makeFakeClient({
        rooms: [ROOM_A],
        commentsInsertError: { code: '23503', message: 'boom' },
      });
      const store = new SupabaseRoomCommentStore(client);

      await expect(
        store.create({ roomId: 'room-a', body: 'hola', clientRequestId: 'req-1' }, AUTHOR),
      ).rejects.toThrow(RoomCommentPersistenceError);
    });
  });
});
