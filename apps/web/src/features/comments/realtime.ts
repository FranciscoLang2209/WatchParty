import { supabase } from '../../lib/supabase';
import type { RoomComment } from './types';

/** Lo mínimo que se usa del cliente: permite probar la suscripción con un doble. */
type ChannelClient = Pick<typeof supabase, 'channel' | 'removeChannel'>;

/**
 * Convierte la fila cruda de `room_comments` al contrato público. Descarta lo
 * que no tiene la forma esperada o no es de la sala pedida, y no expone
 * `author_id` ni `client_request_id`.
 */
function toRoomComment(row: unknown, roomId: string): RoomComment | null {
  if (typeof row !== 'object' || row === null) return null;

  const { id, room_id: rowRoomId, body, created_at: createdAt } = row as Record<string, unknown>;

  if (
    typeof id !== 'string' ||
    typeof body !== 'string' ||
    typeof createdAt !== 'string' ||
    rowRoomId !== roomId
  ) {
    return null;
  }

  return { id, roomId, body, createdAt };
}

/**
 * Escucha los comentarios nuevos de una sala por Supabase Realtime
 * (docs/decisions/realtime-comments.md). Crear y listar sigue siendo por la API.
 *
 * Entrega cada comentario una sola vez (deduplica por `id`: quien comenta
 * recibe también su propio evento). Devuelve la función que cancela la
 * suscripción.
 */
export function subscribeToRoomComments(
  roomId: string,
  onComment: (comment: RoomComment) => void,
  client: ChannelClient = supabase,
): () => void {
  const vistos = new Set<string>();
  let activa = true;

  const channel = client
    .channel(`room-comments:${roomId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'room_comments', filter: `room_id=eq.${roomId}` },
      (payload) => {
        if (!activa) return;

        const comment = toRoomComment(payload.new, roomId);
        if (comment === null || vistos.has(comment.id)) return;

        vistos.add(comment.id);
        onComment(comment);
      },
    )
    .subscribe();

  return () => {
    activa = false;
    void client.removeChannel(channel);
  };
}
