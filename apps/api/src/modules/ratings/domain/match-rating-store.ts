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
 * Resumen público de las notas de un partido (WAT-214). Solo agregados: no
 * incluye ni identidades ni notas individuales.
 *
 * - `count`: votos distintos (un usuario cuenta una vez aunque edite).
 * - `average`: promedio de 1 a 5 con 2 decimales, o `null` si no hay votos.
 *   Las notas nunca bajan de 1, así que "sin votos" (`null`) no se confunde
 *   con un promedio cero.
 */
export interface MatchRatingSummary {
  average: number | null;
  count: number;
}

/**
 * Puerto mínimo para leer y guardar la nota propia de un partido (WAT-212) y
 * para leer el resumen agregado del partido (WAT-214).
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

  /**
   * Cantidad de votos y promedio de `matchId`, calculados por la persistencia
   * (no sobre una lista traída a memoria). Un partido sin votos devuelve
   * `{ average: null, count: 0 }`. No valida que el partido exista: eso es
   * del `MatchRatingService`.
   */
  getSummary(matchId: string): Promise<MatchRatingSummary>;
}
