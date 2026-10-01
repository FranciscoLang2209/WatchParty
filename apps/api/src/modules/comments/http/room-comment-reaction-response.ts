import type { RoomCommentReactionState } from '../domain/room-comment-reaction-store.js';

/**
 * Contrato público HTTP de la reacción propia a un comentario (WAT-176).
 * Hoy tiene la misma forma que `RoomCommentReactionState`, pero se mapea
 * explícitamente igual que `toRoomCommentResponse`: si el dominio suma un
 * campo interno más adelante, no se filtra a la respuesta sin una decisión
 * explícita acá.
 */
export interface RoomCommentReactionResponse {
  count: number;
  reacted: boolean;
}

export function toRoomCommentReactionResponse(
  state: RoomCommentReactionState,
): RoomCommentReactionResponse {
  return {
    count: state.count,
    reacted: state.reacted,
  };
}
