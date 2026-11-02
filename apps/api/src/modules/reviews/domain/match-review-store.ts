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

/**
 * Puerto mínimo para leer la reseña propia de un partido, sobre la tabla
 * `match_reviews` de WAT-252: PK `(user_id, match_id)`.
 *
 * No conoce bearer ni HTTP, y tampoco decide si el partido existe: eso es del
 * `MatchReviewService`. Recibe siempre el `userId` ya resuelto por el
 * middleware de autenticación, así que nunca puede devolver la reseña de otro
 * usuario.
 */
export interface MatchReviewStore {
  /** La reseña de `userId` para `matchId`, o `null` si todavía no reseñó. */
  findReview(userId: string, matchId: string): Promise<MatchReview | null>;
}
