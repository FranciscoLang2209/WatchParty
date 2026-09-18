/**
 * Espejo del contrato público de salas de la Node API (`PublicRoom`, WAT-146).
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/matches`.
 */

/** La sala pública de un partido. Hay una sola por partido. */
export interface PublicRoom {
  id: string;
  matchId: string;
  /** ISO 8601 en UTC, p. ej. «2026-09-17T12:00:00Z». */
  createdAt: string;
}

/** La API envuelve sus respuestas: tanto entrar como consultar devuelven `room`. */
export interface RoomEnvelope {
  room: PublicRoom;
}

/**
 * Motivo por el que falló una consulta.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por el
 * flujo de Auth y `not-found` cubre tanto el partido como la sala inexistente.
 */
export type RoomsErrorKind = 'network' | 'unauthorized' | 'not-found' | 'server' | 'cancelled';

export class RoomsApiError extends Error {
  readonly kind: RoomsErrorKind;

  constructor(kind: RoomsErrorKind, message: string) {
    super(message);
    this.name = 'RoomsApiError';
    this.kind = kind;
  }
}

/** Una consulta cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof RoomsApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof RoomsApiError && error.kind === 'unauthorized';
}
