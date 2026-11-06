/**
 * Reseña de un usuario sobre un partido (WAT-253). Es siempre la del usuario
 * que consulta: no lleva `userId` ni `matchId`, porque ya los conoce quien la
 * pidió. `updatedAt` solo cambia cuando se edita el texto.
 */
export interface MatchReview {
  body: string;
  createdAt: string;
  updatedAt: string;
}

export const MATCH_REVIEW_MAX_LENGTH = 500;

/** Controles C0 y DEL, salvo tabulación, salto de línea y retorno de carro. */
// eslint-disable-next-line no-control-regex -- justamente se buscan caracteres de control
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Texto de reseña normalizado (WAT-254), o `null` si no es válido: tiene que
 * ser un string, y tras quitar los espacios exteriores tener entre 1 y 500
 * caracteres. Se devuelve el texto ya recortado: es el que se guarda.
 *
 * - El largo se cuenta en puntos de código (`char_length` de Postgres), no en
 *   unidades UTF-16: un emoji cuenta como 1, igual que en la base.
 * - Texto plano: no se interpreta ni se escapa nada acá (se guarda tal cual y
 *   quien lo muestre lo trata como texto). Se rechazan los caracteres de
 *   control, y en particular `\u0000`, que Postgres no admite en `text`.
 */
export function normalizeMatchReviewBody(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const body = value.trim();
  if (body.length === 0) return null;
  if ([...body].length > MATCH_REVIEW_MAX_LENGTH) return null;
  if (DISALLOWED_CONTROL_CHARS.test(body)) return null;

  return body;
}

/** Límites de `limit` en `GET /matches/:matchId/reviews` (WAT-256). */
export const MATCH_REVIEWS_PAGE_MIN_LIMIT = 1;
export const MATCH_REVIEWS_PAGE_MAX_LIMIT = 50;
export const MATCH_REVIEWS_PAGE_DEFAULT_LIMIT = 20;

/** Etiqueta cuando el autor no tiene perfil o nombre visible; nunca sale del email. */
export const ANONYMOUS_REVIEW_AUTHOR_NAME = 'Usuario de WatchParty';

/**
 * Opinión pública de un partido (WAT-256). Solo lo que se puede mostrar a
 * cualquier usuario autenticado: sin `userId`, email ni nota.
 */
export interface PublicMatchReview {
  authorName: string;
  body: string;
  createdAt: string;
}

/**
 * Posición en el orden `(created_at desc, user_id desc)` de las reseñas de un
 * partido. `createdAt` es el valor crudo de la base (microsegundos): truncarlo
 * haría reaparecer la última fila en la página siguiente. `userId` solo sirve
 * para desempatar y viaja al cliente únicamente dentro del cursor opaco.
 */
export interface MatchReviewsCursor {
  createdAt: string;
  userId: string;
}

/** Opciones de `listMatchReviews`. `limit` debe ser un entero >= 1. */
export interface ListMatchReviewsOptions {
  limit: number;
  /** Si se omite, la página empieza en la reseña más reciente. */
  after?: MatchReviewsCursor;
}

/** Una página de opiniones; `nextCursor` es `null` cuando no quedan más. */
export interface MatchReviewsPage {
  items: PublicMatchReview[];
  nextCursor: MatchReviewsCursor | null;
}

/**
 * Puerto mínimo para leer, guardar y eliminar la reseña propia de un partido, sobre la
 * tabla `match_reviews` de WAT-252: PK `(user_id, match_id)`.
 *
 * No conoce bearer ni HTTP, y tampoco decide elegibilidad (partido existente,
 * finalizado, visto y calificado): eso es del `MatchReviewService`. Recibe
 * siempre el `userId` ya resuelto por el middleware de autenticación, así que
 * nunca puede leer ni escribir la reseña de otro usuario.
 */
export interface MatchReviewStore {
  /** La reseña de `userId` para `matchId`, o `null` si todavía no reseñó. */
  findReview(userId: string, matchId: string): Promise<MatchReview | null>;

  /**
   * Crea o reemplaza la reseña de `userId` para `matchId` y devuelve la
   * persistida. Idempotente: repetir o editar deja una única fila (la PK hace
   * cumplir "una reseña por par"). `createdAt` se conserva al editar. Lanza
   * `RangeError` si `body` no es un texto ya normalizado
   * (`normalizeMatchReviewBody`).
   */
  saveReview(userId: string, matchId: string, body: string): Promise<MatchReview>;

  /**
   * Elimina la reseña de `userId` para `matchId` (WAT-255). Idempotente: si no
   * había reseña no hace nada y no falla. Solo toca `match_reviews`; la nota,
   * el visto y los agregados viven en otras tablas y no se ven afectados.
   */
  deleteReview(userId: string, matchId: string): Promise<void>;

  /**
   * Página de opiniones de `matchId`, de la más reciente a la más antigua,
   * con desempate por `user_id` (WAT-256): paginada por cursor, así que cada
   * reseña aparece exactamente una vez aunque compartan `created_at`. Un
   * partido sin reseñas devuelve `items: []`. El nombre del autor sale de su
   * perfil; sin perfil o sin nombre, `ANONYMOUS_REVIEW_AUTHOR_NAME`. Lanza
   * `RangeError` si `limit` o el cursor son inválidos.
   */
  listMatchReviews(matchId: string, options: ListMatchReviewsOptions): Promise<MatchReviewsPage>;
}
