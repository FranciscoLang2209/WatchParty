/** Estado de visto de un partido, tras leerlo, marcarlo o deshacerlo, listo para el handler. */
export interface WatchedMatchResult {
  matchId: string;
  watched: boolean;
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
}
