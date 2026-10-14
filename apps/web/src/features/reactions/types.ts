/**
 * Espejo del contrato público de la reacción propia a un comentario de la Node
 * API (`GET`, WAT-206, y `PUT`/`DELETE`, WAT-176, sobre
 * `/rooms/:roomId/comments/:commentId/reaction`), que responde siempre con el
 * estado: `{ reaction: { count, reacted } }`.
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/comments`.
 */

/** Cuántas reacciones tiene el comentario y si la persona autenticada reaccionó. */
export interface ReactionState {
  count: number;
  reacted: boolean;
}

/**
 * Motivo por el que falló una operación.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por el
 * flujo de Auth y `not-found` cubre la sala o el comentario inexistentes.
 */
export type ReactionsErrorKind = 'network' | 'unauthorized' | 'not-found' | 'server' | 'cancelled';

export class ReactionsApiError extends Error {
  readonly kind: ReactionsErrorKind;

  constructor(kind: ReactionsErrorKind, message: string) {
    super(message);
    this.name = 'ReactionsApiError';
    this.kind = kind;
  }
}

/** Una operación cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ReactionsApiError && error.kind === 'cancelled';
}
