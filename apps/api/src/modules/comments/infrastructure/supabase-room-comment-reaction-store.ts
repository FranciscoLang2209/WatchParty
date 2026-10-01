import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  RoomCommentReactionState,
  RoomCommentReactionStore,
  SetRoomCommentReactionInput,
} from '../domain/room-comment-reaction-store.js';
import { RoomCommentPersistenceError } from './room-comment-persistence-error.js';

// invalid_text_representation: un id que no tiene forma de UUID. Se trata
// como "comentario no encontrado" (mismo criterio que `roomExists` en
// supabase-room-comment-store.ts): sin esto, un id mal formado terminaba en
// 500 en vez de 404.
// Referencia: https://www.postgresql.org/docs/current/errcodes-appendix.html
const POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * Implementación de `RoomCommentReactionStore` respaldada por Supabase
 * (WAT-175), sobre `room_comment_reactions` (WAT-165, RLS sin políticas, solo
 * `service_role`) y `room_comments` (WAT-147).
 *
 * La unicidad de "un Me gusta por persona y comentario" la garantiza la base
 * (UNIQUE `(comment_id, user_id)`), no este código: marcar es un INSERT ...
 * ON CONFLICT DO NOTHING, así que reintentos y pedidos concurrentes no
 * duplican filas ni dependen de un "leer y después insertar".
 */
export class SupabaseRoomCommentReactionStore implements RoomCommentReactionStore {
  constructor(private readonly client: SupabaseClient) {}

  async setReaction({
    roomId,
    commentId,
    userId,
    reacted,
  }: SetRoomCommentReactionInput): Promise<RoomCommentReactionState | null> {
    // Antes de mutar: el comentario tiene que existir Y pertenecer a la sala
    // de la ruta. Una sola consulta cubre sala inexistente, comentario
    // inexistente y combinación cruzada.
    if (!(await this.commentBelongsToRoom(roomId, commentId))) return null;

    if (reacted) {
      await this.addReaction(commentId, userId);
    } else {
      await this.removeReaction(commentId, userId);
    }

    const count = await this.countReactions(commentId);

    // `reacted` es el estado que se acaba de fijar para este usuario, no una
    // relectura: la operación es idempotente, así que ya es el estado final.
    return { count, reacted };
  }

  private async commentBelongsToRoom(roomId: string, commentId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('room_comments')
      .select('id')
      .eq('id', commentId)
      .eq('room_id', roomId)
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_INVALID_TEXT_REPRESENTATION) return false;
      throw new RoomCommentPersistenceError(
        `No se pudo verificar el comentario ${commentId} en la sala ${roomId}.`,
        error,
      );
    }

    return data !== null;
  }

  private async addReaction(commentId: string, userId: string): Promise<void> {
    const { error } = await this.client
      .from('room_comment_reactions')
      .upsert(
        { comment_id: commentId, user_id: userId },
        { onConflict: 'comment_id,user_id', ignoreDuplicates: true },
      );

    if (error) {
      throw new RoomCommentPersistenceError(
        `No se pudo marcar el Me gusta del comentario ${commentId}.`,
        error,
      );
    }
  }

  /** Borra solo la fila de `userId`: el filtro por `user_id` es obligatorio. */
  private async removeReaction(commentId: string, userId: string): Promise<void> {
    const { error } = await this.client
      .from('room_comment_reactions')
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', userId);

    if (error) {
      throw new RoomCommentPersistenceError(
        `No se pudo quitar el Me gusta del comentario ${commentId}.`,
        error,
      );
    }
  }

  private async countReactions(commentId: string): Promise<number> {
    const { count, error } = await this.client
      .from('room_comment_reactions')
      .select('id', { count: 'exact', head: true })
      .eq('comment_id', commentId);

    if (error || count === null) {
      throw new RoomCommentPersistenceError(
        `No se pudo contar los Me gusta del comentario ${commentId}.`,
        error ?? undefined,
      );
    }

    return count;
  }
}
