import type { Match } from '../matches/types';

/**
 * Espejo del contrato público del partido visto propio de la Node API
 * (`GET`, WAT-197, y `PUT`/`DELETE /matches/:matchId/watched`, WAT-178), que
 * responde siempre con el estado: `{ watched }`.
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/rooms`.
 */

/**
 * Motivo por el que falló una operación.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por el
 * flujo de Auth y `not-found` cubre el partido inexistente.
 */
export type WatchedErrorKind = 'network' | 'unauthorized' | 'not-found' | 'server' | 'cancelled';

export class WatchedApiError extends Error {
  readonly kind: WatchedErrorKind;

  constructor(kind: WatchedErrorKind, message: string) {
    super(message);
    this.name = 'WatchedApiError';
    this.kind = kind;
  }
}

/** Una operación cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof WatchedApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof WatchedApiError && error.kind === 'unauthorized';
}

/**
 * Espejo del historial propio de vistos de la Node API
 * (`GET /me/watched-matches`, WAT-217), del más reciente al más antiguo.
 */

/** Un partido del historial, con el momento en que se marcó visto. */
export interface WatchedHistoryItem {
  match: Match;
  /** ISO 8601 en UTC, truncado a milisegundos. */
  watchedAt: string;
}

/**
 * Posición desde la que sigue la página siguiente. Es opaco: lo arma el
 * servidor y se devuelve tal cual, sin construirlo ni interpretarlo.
 * `watchedAt` no es el `watchedAt` del ítem: trae la precisión de la base.
 */
export interface WatchedHistoryCursor {
  watchedAt: string;
  matchId: string;
}

/** Una página del historial. `nextCursor` es `null` cuando no quedan más. */
export interface WatchedHistoryPage {
  items: WatchedHistoryItem[];
  nextCursor: WatchedHistoryCursor | null;
}
