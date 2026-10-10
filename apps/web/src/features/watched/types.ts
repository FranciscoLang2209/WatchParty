/**
 * Espejo del contrato público del partido visto propio de la Node API
 * (`PUT`/`DELETE /matches/:matchId/watched`, WAT-178), que responde con el
 * estado final: `{ watched }`.
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
