/**
 * Sala pública de un partido (WAT-146). Existe como máximo una por partido.
 *
 * Contrato público del módulo: solo `id`, `matchId` y `createdAt`, sin
 * ningún detalle de la tabla `rooms` ni de Supabase. La web replica este
 * tipo en `apps/web/src/features/rooms/types.ts` (WAT-161) sin importarlo.
 */
export interface PublicRoom {
  id: string;
  matchId: string;
  /** Fecha de creación en formato ISO 8601 UTC, p. ej. "2026-09-17T12:00:00.000Z". */
  createdAt: string;
}
