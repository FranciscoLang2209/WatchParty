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

// Timestamp tal como lo devuelve Postgres/PostgREST para timestamptz, con
// hasta 6 decimales (microsegundos) y zona horaria. Compartido entre el
// handler HTTP (WAT-174, valida el cursor antes de tocar el store) y el store
// (que lo interpola en un filtro `.or(...)` de PostgREST: un cursor sin
// validar podría alterar la consulta, no solo fallar).
export const CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Límites de `limit` en `GET /rooms/:roomId/comments` (WAT-174). */
export const COMMENTS_PAGE_MIN_LIMIT = 1;
export const COMMENTS_PAGE_MAX_LIMIT = 100;

// Formato canónico de UUID (el mismo que genera gen_random_uuid() en
// Postgres). Compartido entre la validación de formato en el handler HTTP
// (WAT-150, antes de tocar el store) y client_request_id como clave real
// de idempotencia (WAT-147/151) — mismo criterio que UUID_PATTERN en
// modules/profiles/domain/own-profile-store.ts.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Posición de un comentario en el orden `(created_at, id)` de una sala
 * (WAT-168). Es el punto desde el cual continuar: la página siguiente
 * devuelve solo comentarios estrictamente posteriores a esta posición.
 *
 * `createdAt` NO es `RoomComment.createdAt`: es el `created_at` crudo de la
 * base, con precisión de microsegundos (p. ej.
 * "2026-09-19T12:00:00.123456+00:00"). `RoomComment.createdAt` se trunca a
 * milisegundos para la API pública; usarlo como cursor haría que la última
 * fila de una página reaparezca en la siguiente (su `created_at` real es
 * mayor que el valor truncado). Quien reciba un cursor del cliente debe
 * tratarlo como opaco y no construirlo a mano.
 */
export interface RoomCommentCursor {
  createdAt: string;
  id: string;
}

/** Opciones de `listPageByRoom`. `limit` debe ser un entero >= 1. */
export interface ListRoomCommentsPageOptions {
  limit: number;
  /** Si se omite, la página empieza en el primer comentario de la sala. */
  after?: RoomCommentCursor;
}

/**
 * Una página de comentarios en orden cronológico. `nextCursor` es `null`
 * cuando no quedan más comentarios después de `items`.
 */
export interface RoomCommentPage {
  items: RoomComment[];
  nextCursor: RoomCommentCursor | null;
}

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
   * Página de comentarios de `roomId` en el mismo orden que `listByRoom`
   * (`created_at, id`), paginada por cursor en vez de offset: llegar
   * comentarios nuevos no desplaza las páginas ya leídas, y un empate de
   * `created_at` se desempata por `id`, así que cada comentario aparece
   * exactamente una vez. `null` significa que la sala no existe (igual que
   * en `listByRoom`). Lanza `RangeError` si `limit` o el cursor son
   * inválidos.
   */
  listPageByRoom(
    roomId: string,
    options: ListRoomCommentsPageOptions,
  ): Promise<RoomCommentPage | null>;

  /**
   * Crea (o recupera, si `clientRequestId` ya se usó para este autor) un
   * comentario en `roomId`. `authorId` viene siempre del usuario
   * autenticado, nunca de `input`. Devuelve `null` si `roomId` no
   * corresponde a ninguna sala — en ese caso no se inserta ninguna fila.
   */
  create(input: CreateRoomCommentInput, authorId: string): Promise<RoomComment | null>;
}
