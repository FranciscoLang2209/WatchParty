import type { Match } from '../../matches/domain/match.js';

/** Estado de visto de un partido, tras leerlo, marcarlo o deshacerlo, listo para el handler. */
export interface WatchedMatchResult {
  matchId: string;
  watched: boolean;
}

/** Límites de `limit` en `GET /me/watched-matches` (WAT-217). */
export const WATCHED_HISTORY_PAGE_MIN_LIMIT = 1;
export const WATCHED_HISTORY_PAGE_MAX_LIMIT = 50;
export const WATCHED_HISTORY_PAGE_DEFAULT_LIMIT = 20;

// `created_at` tal como lo devuelve PostgREST para timestamptz (hasta
// microsegundos y zona horaria). Mismo patrón que CURSOR_TIMESTAMP_PATTERN en
// modules/comments, definido acá para no acoplar `watched` a otro dominio.
const WATCHED_AT_CURSOR_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Valida el `watchedAt` de un cursor. Lo comparten el handler (valida antes
 * de tocar el store) y el store (lo interpola en un filtro `.or(...)` de
 * PostgREST: sin validar podría alterar la consulta, no solo fallar).
 *
 * El calendario se valida a mano sobre los campos del string: `Date.parse`
 * acepta fechas inexistentes como `2026-02-30` (las desborda al mes
 * siguiente) que PostgreSQL rechaza, y eso terminaría en 500 en vez de 400.
 * No se reconstruye el string desde un `Date`, que perdería los microsegundos.
 */
export function isValidWatchedAtCursor(value: string): boolean {
  const parts = WATCHED_AT_CURSOR_PATTERN.exec(value);
  if (!parts) return false;

  const field = (index: number): number => Number(parts[index]);
  const [year, month, day] = [field(1), field(2), field(3)] as const;
  const [hour, minute, second] = [field(4), field(5), field(6)] as const;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  // PostgreSQL admite offsets de hasta ±15:59.
  if (parts[9] !== undefined && (Number(parts[9]) > 15 || Number(parts[10]) > 59)) return false;

  return true;
}

/**
 * Posición de un partido visto en el orden `(created_at desc, match_id desc)`
 * del historial (WAT-217). La página siguiente devuelve solo vistos
 * estrictamente anteriores a esta posición.
 *
 * `watchedAt` es el `created_at` crudo de la base, con microsegundos — no
 * `WatchedHistoryItem.watchedAt`, que se trunca a milisegundos: mismo motivo
 * que `RoomCommentCursor` en `modules/comments`. El cliente lo trata como
 * opaco.
 */
export interface WatchedHistoryCursor {
  watchedAt: string;
  matchId: string;
}

/** Opciones de `listHistoryPage`. `limit` debe ser un entero >= 1. */
export interface ListWatchedHistoryPageOptions {
  limit: number;
  /** Si se omite, la página empieza en el visto más reciente. */
  before?: WatchedHistoryCursor;
}

/** Un partido del historial propio, con el momento en que se marcó visto. */
export interface WatchedHistoryItem {
  match: Match;
  /** ISO 8601 UTC, truncado a milisegundos. */
  watchedAt: string;
}

/** `nextCursor` es `null` cuando no quedan más vistos después de `items`. */
export interface WatchedHistoryPage {
  items: WatchedHistoryItem[];
  nextCursor: WatchedHistoryCursor | null;
}

/**
 * Puerto mínimo para leer (WAT-197) y marcar/deshacer (WAT-177) el partido
 * visto de un usuario. No conoce bearer ni nada de HTTP: recibe siempre el `userId`
 * ya resuelto por el middleware de autenticación, nunca un campo que el
 * caller controle — mismo criterio que `authorId` en `RoomCommentStore`.
 */
export interface WatchedMatchStore {
  /**
   * Marca (`watched: true`) o deshace (`watched: false`) el partido visto de
   * `userId` para `matchId`. Idempotente: repetir la misma llamada deja el
   * mismo estado final, sin duplicar ni fallar.
   *
   * `null` significa que `matchId` no corresponde a ningún partido
   * existente — no es un error: el handler lo convierte en 404, no en 500.
   */
  setWatched(userId: string, matchId: string, watched: boolean): Promise<WatchedMatchResult | null>;

  /**
   * Lee si `userId` marcó `matchId` como visto. `watched: false` solo cuando
   * la lectura se completó y confirmó que no hay marca: un fallo de
   * persistencia se lanza, nunca se convierte en `false`.
   *
   * `null` significa que `matchId` no corresponde a ningún partido
   * existente, igual que en `setWatched`.
   */
  getWatched(userId: string, matchId: string): Promise<WatchedMatchResult | null>;

  /**
   * Historial de vistos de `userId` (WAT-217), del más reciente al más
   * antiguo, con desempate estable por `match_id`. Paginado por cursor: marcar
   * un partido nuevo no desplaza las páginas ya leídas. Un usuario sin vistos
   * devuelve `items: []`, nunca `null`. Lanza `RangeError` si `limit` o el
   * cursor son inválidos.
   */
  listHistoryPage(
    userId: string,
    options: ListWatchedHistoryPageOptions,
  ): Promise<WatchedHistoryPage>;
}
