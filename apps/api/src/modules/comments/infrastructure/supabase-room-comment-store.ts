import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoomComment } from '../domain/room-comment.js';
import {
  CURSOR_TIMESTAMP_PATTERN,
  UUID_PATTERN,
  type CreateRoomCommentInput,
  type ListRoomCommentsPageOptions,
  type RoomCommentCursor,
  type RoomCommentPage,
  type RoomCommentStore,
} from '../domain/room-comment-store.js';
import { RoomCommentPersistenceError } from './room-comment-persistence-error.js';

const COMMENT_SELECT = 'id, room_id, body, created_at';

// Códigos de error de Postgres: unique_violation (choca con
// room_comments_author_client_request_id_key, WAT-147) e
// invalid_text_representation (un roomId que no tiene forma de UUID). Este
// segundo caso replica el fix documentado para matches en
// claude/revision-wat-106-merged.md: sin este chequeo, un id mal formado
// devolvía 500 en vez de 404 — acá lo tratamos como "sala no encontrada"
// desde el vamos.
// Referencia: https://www.postgresql.org/docs/current/errcodes-appendix.html

const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02';

interface RoomCommentRow {
  id: string;
  room_id: string;
  body: string;
  created_at: string;
}

function toRoomComment(row: RoomCommentRow): RoomComment {
  return {
    id: row.id,
    roomId: row.room_id,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function assertValidCursor(cursor: RoomCommentCursor): void {
  if (!CURSOR_TIMESTAMP_PATTERN.test(cursor.createdAt) || !UUID_PATTERN.test(cursor.id)) {
    throw new RangeError('El cursor de comentarios es inválido.');
  }
}

/**
 * Implementación de `RoomCommentStore` respaldada por Supabase (WAT-151),
 * sobre `room_comments` (WAT-147, RLS sin políticas, solo `service_role`).
 *
 * No depende del módulo `rooms` (WAT-146, todavía sin mergear a `main`):
 * confirma la existencia de la sala con una consulta directa y mínima a
 * `rooms`, igual de simple que lo que haría ese módulo, sin acoplarse a una
 * rama que no está integrada.
 */
export class SupabaseRoomCommentStore implements RoomCommentStore {
  constructor(private readonly client: SupabaseClient) {}

  async listByRoom(roomId: string): Promise<RoomComment[] | null> {
    if (!(await this.roomExists(roomId))) return null;

    const { data, error } = await this.client
      .from('room_comments')
      .select(COMMENT_SELECT)
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (error) {
      throw new RoomCommentPersistenceError(
        `No se pudieron listar los comentarios de la sala ${roomId}.`,
        error,
      );
    }

    return ((data ?? []) as RoomCommentRow[]).map(toRoomComment);
  }

  /**
   * Página por cursor sobre `(created_at, id)` (WAT-168). Pide `limit + 1`
   * filas: si llega la fila extra hay otra página, y se descarta antes de
   * devolver, así que `items` nunca supera `limit`. La comparación con el
   * cursor es estricta (`>`), por lo que el último comentario de la página
   * anterior no se repite.
   */
  async listPageByRoom(
    roomId: string,
    { limit, after }: ListRoomCommentsPageOptions,
  ): Promise<RoomCommentPage | null> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('El límite de la página debe ser un entero mayor o igual a 1.');
    }
    if (after) assertValidCursor(after);

    if (!(await this.roomExists(roomId))) return null;

    let query = this.client.from('room_comments').select(COMMENT_SELECT).eq('room_id', roomId);

    if (after) {
      // (created_at, id) > (after.createdAt, after.id), expresado en el
      // filtro `or` de PostgREST: posterior en fecha, o misma fecha y id mayor.
      query = query.or(
        `created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`,
      );
    }

    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1);

    if (error) {
      throw new RoomCommentPersistenceError(
        `No se pudo listar la página de comentarios de la sala ${roomId}.`,
        error,
      );
    }

    const rows = (data ?? []) as RoomCommentRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map(toRoomComment),
      nextCursor: hasMore && lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : null,
    };
  }

  /**
   * Inserta el comentario y, si choca con la unicidad de
   * `(author_id, client_request_id)`, es porque este mismo autor ya mandó
   * esta misma solicitud antes: se recupera y devuelve ese comentario
   * existente en vez de reintentar o fallar. No hay reintentos en bucle.
   */
  async create(input: CreateRoomCommentInput, authorId: string): Promise<RoomComment | null> {
    if (!(await this.roomExists(input.roomId))) return null;

    const { data, error } = await this.client
      .from('room_comments')
      .insert({
        room_id: input.roomId,
        author_id: authorId,
        body: input.body,
        client_request_id: input.clientRequestId,
      })
      .select(COMMENT_SELECT)
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        const existing = await this.findByClientRequestId(authorId, input.clientRequestId);
        if (existing) return existing;
      }

      throw new RoomCommentPersistenceError(
        `No se pudo crear el comentario en la sala ${input.roomId}.`,
        error,
      );
    }

    return toRoomComment(data as RoomCommentRow);
  }

  private async roomExists(roomId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('rooms')
      .select('id')
      .eq('id', roomId)
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_INVALID_TEXT_REPRESENTATION) return false;
      throw new RoomCommentPersistenceError(`No se pudo verificar la sala ${roomId}.`, error);
    }

    return data !== null;
  }

  private async findByClientRequestId(
    authorId: string,
    clientRequestId: string,
  ): Promise<RoomComment | null> {
    const { data, error } = await this.client
      .from('room_comments')
      .select(COMMENT_SELECT)
      .eq('author_id', authorId)
      .eq('client_request_id', clientRequestId)
      .maybeSingle();

    if (error) {
      throw new RoomCommentPersistenceError(
        `No se pudo recuperar el comentario con client_request_id ${clientRequestId}.`,
        error,
      );
    }

    if (!data) return null;

    return toRoomComment(data as RoomCommentRow);
  }
}
