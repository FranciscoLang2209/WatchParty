/**
 * Espejo del contrato público de comentarios de sala de la Node API
 * (`RoomCommentResponse`, WAT-150).
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/rooms`.
 */

/** Un comentario de una sala. Sin `authorId` ni `clientRequestId`: son internos. */
export interface RoomComment {
  id: string;
  roomId: string;
  body: string;
  /** ISO 8601 en UTC, p. ej. «2026-09-19T12:00:00.000Z». */
  createdAt: string;
}

/**
 * Límites del backend, replicados para validar antes de pedir. Mismos
 * valores que `BODY_MIN_LENGTH`/`BODY_MAX_LENGTH` en
 * `room-comment-store.ts` (API) — el formulario de WAT-153 los comparte, no
 * los reinventa.
 */
export const BODY_MIN_LENGTH = 1;
export const BODY_MAX_LENGTH = 180;

/**
 * Lo que se manda al crear un comentario.
 *
 * `clientRequestId` es la clave de idempotencia (WAT-147): la genera quien
 * arma el intento de envío —el formulario, WAT-153— una sola vez, y la
 * reusa si reintenta tras un fallo. Este módulo no la genera: solo la
 * transporta, igual que `saveOwnProfile` transporta `ProfileInput` sin
 * decidir sus valores.
 */
export interface CommentInput {
  body: string;
  clientRequestId: string;
}

/** La API envuelve sus respuestas: tanto crear como listar devuelven esto. */
export interface CommentEnvelope {
  comment: RoomComment;
}

export interface CommentsEnvelope {
  comments: RoomComment[];
}

/**
 * Posición desde la que sigue la página siguiente (WAT-174). Es opaco: lo
 * arma el servidor y se devuelve tal cual, sin construirlo ni interpretarlo.
 * `createdAt` no es el `createdAt` del comentario: trae la precisión de la base.
 */
export interface CommentsCursor {
  createdAt: string;
  id: string;
}

/** Una página de comentarios. `nextCursor` es `null` cuando no quedan más. */
export interface CommentsPage {
  comments: RoomComment[];
  nextCursor: CommentsCursor | null;
}

export interface CommentsPageEnvelope {
  comments: RoomComment[];
  nextCursor?: CommentsCursor | null;
}

/**
 * Motivo por el que falló una consulta.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por
 * el flujo de Auth, `not-found` cubre la sala inexistente, e `invalid` es el
 * 400 que devuelve el backend cuando el comentario no respeta sus límites.
 */
export type CommentsErrorKind =
  'network' | 'unauthorized' | 'not-found' | 'invalid' | 'server' | 'cancelled';

export class CommentsApiError extends Error {
  readonly kind: CommentsErrorKind;

  constructor(kind: CommentsErrorKind, message: string) {
    super(message);
    this.name = 'CommentsApiError';
    this.kind = kind;
  }
}

/** Una consulta cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof CommentsApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof CommentsApiError && error.kind === 'unauthorized';
}
