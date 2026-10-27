/**
 * Espejo del contrato público de `GET /me/statistics` de la Node API (WAT-232),
 * que responde `{ statistics }` con los totales propios (WAT-231).
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/watched`.
 */

/** Totales de actividad propia. Sin actividad, la API responde ceros. */
export interface UserStatistics {
  /** Partidos marcados como vistos. */
  watchedMatches: number;
  /** Partidos calificados: una nota por partido. */
  ratings: number;
  /** Comentarios publicados en las salas. */
  comments: number;
}

export interface StatisticsEnvelope {
  statistics: UserStatistics;
}

/**
 * Motivo por el que falló la consulta.
 *
 * `cancelled` nunca se le muestra a la persona y `unauthorized` reingresa por
 * el flujo de Auth.
 */
export type StatisticsErrorKind = 'network' | 'unauthorized' | 'server' | 'cancelled';

export class StatisticsApiError extends Error {
  readonly kind: StatisticsErrorKind;

  constructor(kind: StatisticsErrorKind, message: string) {
    super(message);
    this.name = 'StatisticsApiError';
    this.kind = kind;
  }
}

/** Una consulta cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof StatisticsApiError && error.kind === 'cancelled';
}
