export const MATCH_RATING_MIN = 1;
export const MATCH_RATING_MAX = 5;

/**
 * Una nota válida es un entero entre 1 y 5. Se exige `typeof === 'number'`:
 * "4" (string), `null`, booleanos y decimales como 3.5 se rechazan en vez de
 * coercionarse. Lo comparte el handler (valida antes de tocar nada) y el
 * store (última barrera antes de escribir, ya que la base redondearía un
 * literal decimal SQL — ver pendientes de WAT-211).
 */
export function isValidMatchRating(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MATCH_RATING_MIN &&
    value <= MATCH_RATING_MAX
  );
}

/**
 * Puerto mínimo para leer y guardar la nota propia de un partido (WAT-212).
 * Sobre la tabla `match_ratings` de WAT-211: PK `(user_id, match_id)`.
 *
 * No conoce bearer ni HTTP, y tampoco decide elegibilidad (partido
 * existente, finalizado y visto): eso es del `MatchRatingService`. Recibe
 * siempre el `userId` ya resuelto por el middleware de autenticación.
 */
export interface MatchRatingStore {
  /** La nota de `userId` para `matchId`, o `null` si todavía no calificó. */
  findRating(userId: string, matchId: string): Promise<number | null>;

  /**
   * Crea o reemplaza la nota de `userId` para `matchId` y devuelve la
   * persistida. Idempotente: repetir o editar deja una única fila (la
   * PK hace cumplir "una nota por par"). Lanza `RangeError` si `rating` no
   * es un entero 1–5.
   */
  saveRating(userId: string, matchId: string, rating: number): Promise<number>;
}
