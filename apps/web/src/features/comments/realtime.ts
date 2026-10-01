import { supabase } from '../../lib/supabase';
import type { RoomComment } from './types';

/** Lo mínimo que se usa del cliente: permite probar la suscripción con un doble. */
type ChannelClient = Pick<typeof supabase, 'channel' | 'removeChannel'>;

/**
 * Si la escucha en vivo está operativa. Arranca en `disconnected`: sólo pasa a
 * `connected` cuando el canal confirma la suscripción.
 */
export type RoomCommentsStatus = 'connected' | 'disconnected';

export interface SubscribeToRoomCommentsOptions {
  /**
   * Avisa la primera respuesta del canal (aunque sea una caída) y después cada
   * cambio de estado. Mientras no avisa nada, la suscripción sigue sin
   * confirmar.
   */
  onStatusChange?: (status: RoomCommentsStatus) => void;
  client?: ChannelClient;
}

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
 * suscripción, que además deja el estado en `disconnected`.
 */
export function subscribeToRoomComments(
  roomId: string,
  onComment: (comment: RoomComment) => void,
  { onStatusChange, client = supabase }: SubscribeToRoomCommentsOptions = {},
): () => void {
  const vistos = new Set<string>();
  let activa = true;
  // `null` hasta la primera respuesta del canal: así una caída inicial también
  // se avisa, y quien escucha puede distinguirla de «todavía conectando».
  let estado: RoomCommentsStatus | null = null;

  const cambiarEstado = (nuevo: RoomCommentsStatus) => {
    if (nuevo === estado) return;

    estado = nuevo;
    onStatusChange?.(nuevo);
  };

  const channel = client
    .channel(`room-comments:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'room_comments',
        filter: `room_id=eq.${roomId}`,
        // Sólo estas columnas son legibles por `authenticated` (GRANT en la
        // migración de Realtime): el payload nunca trae author_id ni
        // client_request_id.
        select: ['id', 'room_id', 'body', 'created_at'],
      },
      (payload) => {
        if (!activa) return;

        const comment = toRoomComment(payload.new, roomId);
        if (comment === null || vistos.has(comment.id)) return;

        vistos.add(comment.id);
        onComment(comment);
      },
    )
    // Cualquier aviso que no sea `SUBSCRIBED` (error, timeout o cierre) es una
    // caída: el canal no está entregando comentarios.
    .subscribe((estadoDelCanal) => {
      if (!activa) return;

      cambiarEstado(estadoDelCanal === 'SUBSCRIBED' ? 'connected' : 'disconnected');
    });

  return () => {
    cambiarEstado('disconnected');
    activa = false;
    void client.removeChannel(channel);
  };
}
