/**
 * Comentario de una sala (WAT-140/147/151). Existe sobre `room_comments`,
 * con idempotencia por `client_request_id` y autor derivado siempre del
 * servidor (WAT-150).
 *
 * Contrato público del módulo: sin `authorId`, `clientRequestId` ni ningún
 * detalle de la tabla — mismo criterio que `Profile` en `modules/profiles`.
 */
export interface RoomComment {
  id: string;
  roomId: string;
  body: string;
  /** Fecha de creación en formato ISO 8601 UTC, p. ej. "2026-09-19T12:00:00.000Z". */
  createdAt: string;
}
