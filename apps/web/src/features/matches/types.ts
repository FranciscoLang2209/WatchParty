/**
 * Espejo del contrato público de la Node API (`apps/api/.../match-response.ts`).
 * La web no importa runtime del servidor: replica los tipos y las pruebas
 * protegen que no se desvíen.
 */

/** Los cinco estados del dominio. No hay otros. */
export const MATCH_STATUSES = ['scheduled', 'live', 'finished', 'postponed', 'cancelled'] as const;

export type MatchStatus = (typeof MATCH_STATUSES)[number];

export interface Match {
  id: string;
  homeTeam: string;
  awayTeam: string;
  /** ISO 8601 en UTC, p. ej. «2026-09-06T21:00:00Z». */
  kickoffAt: string;
  status: MatchStatus;
}

/** La API envuelve sus respuestas: la lista en `matches` y el detalle en `match`. */
export interface MatchesEnvelope {
  matches: Match[];
}

export interface MatchEnvelope {
  match: Match;
}

/**
 * Motivo por el que falló una consulta.
 *
 * Las pantallas necesitan distinguirlos: `cancelled` nunca se le muestra a la
 * persona, `unauthorized` reingresa por el flujo de Auth, y ningún fallo puede
 * presentarse como «no hay partidos».
 */
export type MatchesErrorKind = 'network' | 'unauthorized' | 'not-found' | 'server' | 'cancelled';

export class MatchesApiError extends Error {
  readonly kind: MatchesErrorKind;

  constructor(kind: MatchesErrorKind, message: string) {
    super(message);
    this.name = 'MatchesApiError';
    this.kind = kind;
  }
}

/** Una consulta cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof MatchesApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof MatchesApiError && error.kind === 'unauthorized';
}
