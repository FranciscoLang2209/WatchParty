import type { RoomComment } from '../domain/room-comment.js';

/**
 * Contrato público HTTP de un comentario. Hoy tiene la misma forma que
 * `RoomComment`, pero se mapea explícitamente igual que `MatchResponse` en
 * `modules/matches`: si el dominio suma un campo interno más adelante, no
 * se filtra a la respuesta sin una decisión explícita acá.
 */
export interface RoomCommentResponse {
  id: string;
  roomId: string;
  body: string;
  createdAt: string;
}

export function toRoomCommentResponse(comment: RoomComment): RoomCommentResponse {
  return {
    id: comment.id,
    roomId: comment.roomId,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}
