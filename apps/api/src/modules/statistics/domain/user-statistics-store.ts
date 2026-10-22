/** Totales de actividad propia de un usuario (WAT-231). */
export interface UserStatistics {
  /** Partidos marcados como vistos. */
  watchedMatches: number;
  /** Partidos calificados: una nota por partido, editarla no suma otra. */
  ratings: number;
  /** Comentarios publicados en las salas. */
  comments: number;
}

/**
 * Puerto de lectura de los totales de un usuario. Cuenta sobre las tablas de
 * cada frente (vistos, notas y comentarios), sin tablas de contadores propias.
 *
 * Sin actividad devuelve ceros; un fallo de consulta lanza, nunca se
 * convierte en cero.
 */
export interface UserStatisticsStore {
  getUserStatistics(userId: string): Promise<UserStatistics>;
}
