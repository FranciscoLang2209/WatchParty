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

      function matching() {
        return comments.filter((row) =>
          Object.entries(filters).every(
            ([column, value]) => row[column as keyof RoomCommentRow] === value,
          ),
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

          resolve({ data: sortedMatching(), error: null });
        },
      };

      return builder;
    }

    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  return { from } as unknown as SupabaseClient;
}

const ROOM_A = { id: 'room-a' };
const AUTHOR = 'author-1';

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
