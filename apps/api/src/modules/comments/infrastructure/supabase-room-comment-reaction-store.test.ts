import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SetRoomCommentReactionInput } from '../domain/room-comment-reaction-store.js';
import { SupabaseRoomCommentReactionStore } from './supabase-room-comment-reaction-store.js';
import { RoomCommentPersistenceError } from './room-comment-persistence-error.js';

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const ROOM_MISSING = '99999999-9999-4999-8999-999999999999';

const COMMENT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const COMMENT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const COMMENT_B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const COMMENT_MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Texto que simula un detalle interno de Postgres: nunca debe aparecer en el
// `message` de los errores que lanza el store.
const RAW_DB_MESSAGE = 'detalle interno de postgres: relation "x" column "y"';

interface CommentRow {
  id: string;
  room_id: string;
}

interface ReactionRow {
  id: string;
  comment_id: string;
  user_id: string;
}

type FakeError = { code?: string; message: string };

interface FakeClientOptions {
  reactions?: ReactionRow[];
  commentsSelectError?: FakeError;
  reactionsWriteError?: FakeError;
  reactionsCountError?: FakeError;
}

const COMMENTS: CommentRow[] = [
  { id: COMMENT_A1, room_id: ROOM_A },
  { id: COMMENT_A2, room_id: ROOM_A },
  { id: COMMENT_B1, room_id: ROOM_B },
];

let nextReactionId = 0;

function reaction(commentId: string, userId: string): ReactionRow {
  nextReactionId += 1;
  return { id: `reaction-${nextReactionId}`, comment_id: commentId, user_id: userId };
}

/**
 * Doble de Supabase con dos tablas en memoria (`room_comments`,
 * `room_comment_reactions`), mismo criterio que
 * `supabase-room-comment-store.test.ts`: las pruebas verifican el estado
 * observable de las tablas, no qué métodos internos se llamaron. El fake
 * respeta lo que importa de la base real:
 *
 * - UNIQUE `(comment_id, user_id)`: un upsert con `ignoreDuplicates` no
 *   agrega la fila si ya existe (ON CONFLICT DO NOTHING).
 * - FK `comment_id`: insertar una reacción de un comentario inexistente falla.
 * - `uuid`: filtrar `room_comments` con un valor que no es UUID falla con
 *   22P02, como Postgres.
 * - Un DELETE sin filtros se rechaza (PostgREST también lo rechaza), así que
 *   si el store olvidara filtrar por `user_id`... borraría de más y las
 *   pruebas de aislamiento lo detectan.
 *
 * Devuelve `reactions` (la tabla viva) para poder inspeccionarla.
 */
function makeFakeClient(options: FakeClientOptions = {}) {
  const reactions = [...(options.reactions ?? [])];

  const from = vi.fn((table: string) => {
    if (table === 'room_comments') {
      const filters: Record<string, string> = {};

      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          filters[column] = value;
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (options.commentsSelectError) {
            return { data: null, error: options.commentsSelectError };
          }

          if (Object.values(filters).some((value) => !UUID_SHAPE.test(value))) {
            return {
              data: null,
              error: { code: '22P02', message: 'invalid input syntax for type uuid' },
            };
          }

          const found = COMMENTS.find((row) =>
            Object.entries(filters).every(
              ([column, value]) => row[column as keyof CommentRow] === value,
            ),
          );

          return { data: found ?? null, error: null };
        }),
      };

      return builder;
    }

    if (table === 'room_comment_reactions') {
      const filters: Record<string, string> = {};
      let operation: 'select' | 'delete' | undefined;

      function matching() {
        return reactions.filter((row) =>
          Object.entries(filters).every(
            ([column, value]) => row[column as keyof ReactionRow] === value,
          ),
        );
      }

      const builder = {
        upsert: vi.fn(
          async (
            row: { comment_id: string; user_id: string },
            upsertOptions?: { onConflict?: string; ignoreDuplicates?: boolean },
          ) => {
            if (options.reactionsWriteError) return { error: options.reactionsWriteError };

            if (
              upsertOptions?.onConflict !== 'comment_id,user_id' ||
              upsertOptions.ignoreDuplicates !== true
            ) {
              throw new Error(
                'El fake solo soporta upsert con onConflict "comment_id,user_id" e ignoreDuplicates.',
              );
            }

            if (!COMMENTS.some((comment) => comment.id === row.comment_id)) {
              return {
                error: { code: '23503', message: 'violates foreign key constraint' },
              };
            }

            const exists = reactions.some(
              (existing) =>
                existing.comment_id === row.comment_id && existing.user_id === row.user_id,
            );
            if (!exists) reactions.push(reaction(row.comment_id, row.user_id));

            return { error: null };
          },
        ),
        select: vi.fn(() => {
          operation = 'select';
          return builder;
        }),
        delete: vi.fn(() => {
          operation = 'delete';
          return builder;
        }),
        eq: vi.fn((column: string, value: string) => {
          filters[column] = value;
          return builder;
        }),
        // `delete().eq().eq()` y `select(..., { head: true }).eq()` se
        // esperan directamente, sin método terminal — igual que el query
        // builder real de Supabase, que es "thenable".
        then: (resolve: (value: { count: number | null; error: FakeError | null }) => void) => {
          if (operation === 'delete') {
            if (options.reactionsWriteError) {
              resolve({ count: null, error: options.reactionsWriteError });
              return;
            }

            if (Object.keys(filters).length === 0) {
              throw new Error('El fake no permite DELETE sin filtros.');
            }

            const doomed = new Set(matching());
            const remaining = reactions.filter((row) => !doomed.has(row));
            reactions.splice(0, reactions.length, ...remaining);
            resolve({ count: null, error: null });
            return;
          }

          if (options.reactionsCountError) {
            resolve({ count: null, error: options.reactionsCountError });
            return;
          }

          resolve({ count: matching().length, error: null });
        },
      };

      return builder;
    }

    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  return {
    client: { from } as unknown as SupabaseClient,
    reactions,
  };
}

function input(overrides: Partial<SetRoomCommentReactionInput> = {}): SetRoomCommentReactionInput {
  return {
    roomId: ROOM_A,
    commentId: COMMENT_A1,
    userId: USER_1,
    reacted: true,
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Se esperaba que la promesa fallara.');
}

describe('SupabaseRoomCommentReactionStore.setReaction', () => {
  describe('marcar', () => {
    it('crea una sola fila y devuelve reacted: true con el conteo actualizado', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input());

      expect(result).toEqual({ count: 1, reacted: true });
      expect(reactions).toHaveLength(1);
      expect(reactions[0]).toMatchObject({ comment_id: COMMENT_A1, user_id: USER_1 });
    });

    it('repetir el marcado no crea otra fila ni aumenta el conteo', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      await store.setReaction(input());
      const repeated = await store.setReaction(input());

      expect(repeated).toEqual({ count: 1, reacted: true });
      expect(reactions).toHaveLength(1);
    });

    it('cuenta las reacciones de otros usuarios sobre el mismo comentario', async () => {
      const { client } = makeFakeClient({ reactions: [reaction(COMMENT_A1, USER_2)] });
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ userId: USER_1 }));

      expect(result).toEqual({ count: 2, reacted: true });
    });

    it('no cuenta las reacciones de otros comentarios', async () => {
      const { client } = makeFakeClient({ reactions: [reaction(COMMENT_A2, USER_2)] });
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ commentId: COMMENT_A1 }));

      expect(result).toEqual({ count: 1, reacted: true });
    });
  });

  describe('desmarcar', () => {
    it('elimina la fila del usuario y devuelve reacted: false', async () => {
      const { client, reactions } = makeFakeClient({ reactions: [reaction(COMMENT_A1, USER_1)] });
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ reacted: false }));

      expect(result).toEqual({ count: 0, reacted: false });
      expect(reactions).toHaveLength(0);
    });

    it('elimina solo la fila del usuario autenticado y deja la de otro usuario', async () => {
      const { client, reactions } = makeFakeClient({
        reactions: [reaction(COMMENT_A1, USER_1), reaction(COMMENT_A1, USER_2)],
      });
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ userId: USER_1, reacted: false }));

      expect(result).toEqual({ count: 1, reacted: false });
      expect(reactions).toHaveLength(1);
      expect(reactions[0]).toMatchObject({ comment_id: COMMENT_A1, user_id: USER_2 });
    });

    it('no toca las reacciones del mismo usuario en otros comentarios', async () => {
      const { client, reactions } = makeFakeClient({
        reactions: [reaction(COMMENT_A1, USER_1), reaction(COMMENT_A2, USER_1)],
      });
      const store = new SupabaseRoomCommentReactionStore(client);

      await store.setReaction(input({ commentId: COMMENT_A1, reacted: false }));

      expect(reactions).toHaveLength(1);
      expect(reactions[0]).toMatchObject({ comment_id: COMMENT_A2, user_id: USER_1 });
    });

    it('sin fila previa es idempotente y deja el conteo correcto', async () => {
      const { client, reactions } = makeFakeClient({ reactions: [reaction(COMMENT_A1, USER_2)] });
      const store = new SupabaseRoomCommentReactionStore(client);

      const first = await store.setReaction(input({ userId: USER_1, reacted: false }));
      const second = await store.setReaction(input({ userId: USER_1, reacted: false }));

      expect(first).toEqual({ count: 1, reacted: false });
      expect(second).toEqual({ count: 1, reacted: false });
      expect(reactions).toHaveLength(1);
    });
  });

  describe('dos usuarios', () => {
    it('cada usuario tiene su propia reacción y ambas suman al conteo', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      const first = await store.setReaction(input({ userId: USER_1 }));
      const second = await store.setReaction(input({ userId: USER_2 }));

      expect(first).toEqual({ count: 1, reacted: true });
      expect(second).toEqual({ count: 2, reacted: true });
      expect(reactions.map((row) => row.user_id).sort()).toEqual([USER_1, USER_2]);
    });

    it('un usuario no puede alterar la reacción de otro: marcar y desmarcar solo mueven la propia', async () => {
      const { client, reactions } = makeFakeClient({ reactions: [reaction(COMMENT_A1, USER_2)] });
      const store = new SupabaseRoomCommentReactionStore(client);

      await store.setReaction(input({ userId: USER_1, reacted: true }));
      await store.setReaction(input({ userId: USER_1, reacted: false }));

      expect(reactions).toHaveLength(1);
      expect(reactions[0]).toMatchObject({ comment_id: COMMENT_A1, user_id: USER_2 });
    });
  });

  describe('sala o comentario inválidos', () => {
    it.each([true, false])(
      'devuelve null y no muta datos si el comentario es de otra sala (reacted: %s)',
      async (reacted) => {
        const seed = [reaction(COMMENT_B1, USER_1)];
        const { client, reactions } = makeFakeClient({ reactions: [...seed] });
        const store = new SupabaseRoomCommentReactionStore(client);

        // COMMENT_B1 existe, pero pertenece a ROOM_B, no a ROOM_A.
        const result = await store.setReaction(
          input({ roomId: ROOM_A, commentId: COMMENT_B1, reacted }),
        );

        expect(result).toBeNull();
        expect(reactions).toEqual(seed);
      },
    );

    it('devuelve null y no inserta si el comentario no existe', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ commentId: COMMENT_MISSING }));

      expect(result).toBeNull();
      expect(reactions).toHaveLength(0);
    });

    it('devuelve null y no inserta si la sala no existe', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ roomId: ROOM_MISSING }));

      expect(result).toBeNull();
      expect(reactions).toHaveLength(0);
    });

    it('trata un commentId con formato inválido como inexistente, sin lanzar', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ commentId: 'no-es-un-uuid' }));

      expect(result).toBeNull();
      expect(reactions).toHaveLength(0);
    });

    it('trata un roomId con formato inválido como inexistente, sin lanzar', async () => {
      const { client, reactions } = makeFakeClient();
      const store = new SupabaseRoomCommentReactionStore(client);

      const result = await store.setReaction(input({ roomId: 'no-es-un-uuid' }));

      expect(result).toBeNull();
      expect(reactions).toHaveLength(0);
    });
  });

  describe('errores de base', () => {
    const rawError: FakeError = { code: 'XX000', message: RAW_DB_MESSAGE };

    const cases: [string, FakeClientOptions, boolean][] = [
      ['verificar el comentario', { commentsSelectError: rawError }, true],
      ['marcar', { reactionsWriteError: rawError }, true],
      ['quitar', { reactionsWriteError: rawError }, false],
      ['contar', { reactionsCountError: rawError }, true],
    ];

    it.each(cases)(
      'al fallar %s lanza RoomCommentPersistenceError sin filtrar el error crudo',
      async (_step, clientOptions, reacted) => {
        const { client } = makeFakeClient(clientOptions);
        const store = new SupabaseRoomCommentReactionStore(client);

        const error = await captureError(store.setReaction(input({ reacted })));

        expect(error).toBeInstanceOf(RoomCommentPersistenceError);
        expect((error as RoomCommentPersistenceError).message).not.toContain(RAW_DB_MESSAGE);
        expect((error as Error).cause).toEqual(rawError);
      },
    );
  });
});
