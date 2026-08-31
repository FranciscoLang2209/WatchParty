/**
 * Estados posibles de un partido dentro del dominio de WatchParty.
 */

export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';

/**
 * Modelo canónico de un partido.
 *
 * Es el único modelo de "partido" que deben conocer los consumidores
 * (handlers HTTP, servicios, etc.). No debe crearse otra representación
 * de Match en el módulo.
 */

export interface Match {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string; /** Fecha y hora de inicio en formato ISO 8601 UTC, p. ej. "2026-09-06T21:00:00Z". */
  status: MatchStatus;
}
