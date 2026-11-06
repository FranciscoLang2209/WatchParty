/**
 * Espejo del contrato público de reseñas de la Node API (WAT-253 a WAT-256):
 *
 * - `GET`, `PUT` y `DELETE /matches/:matchId/review`: la reseña PROPIA. Las
 *   tres responden `{ review }`, con `review: null` si la persona no tiene
 *   texto (siempre en `DELETE`).
 * - `GET /matches/:matchId/reviews`: las opiniones públicas del partido,
 *   paginadas por cursor: `{ reviews, nextCursor }`.
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/ratings`.
 */

/** Límites del texto, replicados de la API para validar antes de pedir. */
export const REVIEW_BODY_MIN_LENGTH = 1;
export const REVIEW_BODY_MAX_LENGTH = 500;

/**
 * Texto de reseña listo para enviar, o `null` si no es válido: tiene que ser
 * un string y, tras quitar los espacios exteriores, tener entre 1 y 500
 * caracteres. El largo se cuenta en puntos de código, como en la base: un emoji
 * es un carácter. La API vuelve a validar todo; esto evita pedidos que ya se
 * sabe que va a rechazar.
 */
export function toReviewBody(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const body = value.trim();
  const length = [...body].length;

  if (length < REVIEW_BODY_MIN_LENGTH || length > REVIEW_BODY_MAX_LENGTH) return null;

  return body;
}

/**
 * La reseña propia, tal como la confirma el servidor. Sin `userId` ni
 * `matchId`: siempre es la de la persona autenticada. `updatedAt` sólo cambia
 * cuando se edita el texto.
 */
export interface OwnReview {
  body: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * Una opinión pública de un partido. Sin identificador de cuenta, email ni
 * nota: sólo lo que se puede mostrar a cualquier persona autenticada.
 */
export interface PublicReview {
  authorName: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * Una página de opiniones. `nextCursor` es opaco: lo arma (y cifra) el
 * servidor, se devuelve tal cual en la página siguiente y nunca se construye
 * ni se interpreta acá. `null` cuando no quedan más.
 */
export interface ReviewsPage {
  reviews: PublicReview[];
  nextCursor: string | null;
}

/**
 * Motivo por el que falló una operación.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por el
 * flujo de Auth, `not-found` cubre el partido inexistente y `conflict` el
 * partido que (todavía) no admite reseña: no finalizado, no marcado como visto
 * o sin calificación propia. `network` y `server` son recuperables: reintentar
 * puede funcionar. `validation` es un pedido que el servidor rechazó: reintentar
 * igual no sirve.
 */
export type ReviewsErrorKind =
  'network' | 'unauthorized' | 'not-found' | 'conflict' | 'validation' | 'server' | 'cancelled';

export class ReviewsApiError extends Error {
  readonly kind: ReviewsErrorKind;

  constructor(kind: ReviewsErrorKind, message: string) {
    super(message);
    this.name = 'ReviewsApiError';
    this.kind = kind;
  }
}

/** Una operación cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ReviewsApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ReviewsApiError && error.kind === 'unauthorized';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ReviewsApiError && error.kind === 'not-found';
}

/** Un fallo transitorio: sin conexión o error del servidor. Vale la pena reintentar. */
export function isRecoverable(error: unknown): boolean {
  return error instanceof ReviewsApiError && (error.kind === 'network' || error.kind === 'server');
}
