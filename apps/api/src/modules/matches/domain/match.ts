/**
 * Estados posibles de un partido dentro del dominio de WatchParty.
 */

export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';

/**
 * Marcador real informado por el proveedor (WAT-230). Es independiente del
 * estado: un partido puede estar finalizado y todavía no tener marcador.
 */
export interface MatchScore {
  home: number;
  away: number;
}

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
  /** UUID de `teams`. El nombre no es único: el equipo se identifica por id. */
  homeTeamId: string;
  awayTeam: string;
  awayTeamId: string;
  kickoffAt: string; /** Fecha y hora de inicio en formato ISO 8601 UTC, p. ej. "2026-09-06T21:00:00Z". */
  status: MatchStatus;
  /** `null` cuando no hay resultado: nunca un 0–0 inventado. */
  score: MatchScore | null;
}
