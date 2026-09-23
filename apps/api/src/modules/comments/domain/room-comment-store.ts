import type { RoomComment } from './room-comment.js';

/**
 * Input para crear un comentario. `roomId` y `body` vienen del cliente;
 * `clientRequestId` es la clave de idempotencia (WAT-147: UNIQUE en
 * `(author_id, client_request_id)`). El autor NUNCA viaja acá — se recibe
 * como parámetro separado de `create`, tomado siempre del servidor
 * (usuario autenticado), nunca de un campo que el caller pueda controlar.
 */
export interface CreateRoomCommentInput {
  roomId: string;
  body: string;
  clientRequestId: string;
}

/**
 * Límites de `body`, documentados acá para que el handler HTTP (WAT-150) y
 * el store compartan el mismo límite sin duplicarlo a ciegas — mismo
 * criterio que `DISPLAY_NAME_MAX_LENGTH` en `modules/profiles`.
 */
export const BODY_MIN_LENGTH = 1;
export const BODY_MAX_LENGTH = 180;

// Formato canónico de UUID (el mismo que genera gen_random_uuid() en
// Postgres). Compartido entre la validación de formato en el handler HTTP
// (WAT-150, antes de tocar el store) y client_request_id como clave real
// de idempotencia (WAT-147/151) — mismo criterio que UUID_PATTERN en
// modules/profiles/domain/own-profile-store.ts.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Puerto mínimo de comentarios de sala (WAT-151). No es un repositorio
 * genérico: solo expone lo que este módulo necesita.
 */
export interface RoomCommentStore {
  /**
   * Comentarios de `roomId` ordenados por `created_at, id` (orden estable
   * ante timestamps iguales). `null` significa que la sala no existe —
   * distinto de `[]`, que es una sala real todavía sin comentarios.
   */
  listByRoom(roomId: string): Promise<RoomComment[] | null>;

  /**
   * Crea (o recupera, si `clientRequestId` ya se usó para este autor) un
   * comentario en `roomId`. `authorId` viene siempre del usuario
   * autenticado, nunca de `input`. Devuelve `null` si `roomId` no
   * corresponde a ninguna sala — en ese caso no se inserta ninguna fila.
   */
  create(input: CreateRoomCommentInput, authorId: string): Promise<RoomComment | null>;
}
