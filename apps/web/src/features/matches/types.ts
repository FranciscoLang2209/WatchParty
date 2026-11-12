/**
 * Espejo del contrato público de la Node API (`apps/api/.../match-response.ts`).
 * La web no importa runtime del servidor: replica los tipos y las pruebas
 * protegen que no se desvíen.
 */

/** Los cinco estados del dominio. No hay otros. */
export const MATCH_STATUSES = ['scheduled', 'live', 'finished', 'postponed', 'cancelled'] as const;

export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Marcador real del partido. Es independiente del estado. */
export interface MatchScore {
  home: number;
  away: number;
}

export interface Match {
  id: string;
  homeTeam: string;
  /** Id del equipo en el directorio. El nombre no es único: se identifica por id. */
  homeTeamId: string;
  awayTeam: string;
  awayTeamId: string;
  /** ISO 8601 en UTC, p. ej. «2026-09-06T21:00:00Z». */
  kickoffAt: string;
  status: MatchStatus;
  /** `null` cuando no hay resultado: nunca se muestra como 0–0. */
  score: MatchScore | null;
}

/** Página de la búsqueda de partidos (`GET /matches/search`). */
export interface MatchSearchPage {
  matches: Match[];
  /** `null` cuando no hay otra página; si no, se pasa como `cursor` para pedirla. */
  nextCursor: string | null;
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

/**
 * Detalle histórico (estadísticas y goles) de un partido terminado, tal como lo entrega
 * `GET /matches/:matchId/historical-detail`. Son datos cerrados de un proveedor complementario,
 * sin actualización en vivo. Espejo de `apps/api/.../historical-detail-response.ts`.
 */

/** Una métrica es un número real (el `0` es un dato) o `null` = sin dato. Nunca se mezclan. */
export interface TeamStatistics {
  /** Porcentaje 0–100. */
  possessionPct: number | null;
  totalShots: number | null;
  shotsOnGoal: number | null;
  cornerKicks: number | null;
  fouls: number | null;
}

/** `complete`: ambos equipos y las cinco métricas. `partial`: cobertura restringida. */
export type StatisticsCoverage = 'complete' | 'partial';

export interface HistoricalStatistics {
  coverage: StatisticsCoverage;
  /** ISO 8601 UTC de la consulta al proveedor. */
  fetchedAt: string;
  home: TeamStatistics;
  away: TeamStatistics;
}

export type GoalKind = 'goal' | 'own_goal' | 'penalty_goal' | 'goal_cancelled' | 'shootout_goal';

export interface GoalEntry {
  kind: GoalKind;
  side: 'home' | 'away';
  /** `null` cuando el proveedor no informó el autor. */
  playerName: string | null;
  minute: number;
  /** Añadido (45+2 → minute 45, extraMinute 2); `null` si no hay. */
  extraMinute: number | null;
}

/** `complete`: la cronología coincide con el marcador. `incomplete`: no se pudo comprobar. */
export type GoalsCoverage = 'complete' | 'incomplete';

export interface HistoricalGoals {
  coverage: GoalsCoverage;
  fetchedAt: string;
  /** Sólo goles del juego. */
  goals: GoalEntry[];
  /** Anulaciones (VAR): no suman al marcador. */
  cancelled: GoalEntry[];
  /** Tanda de penales: no son goles del juego. */
  shootout: GoalEntry[];
}

export interface HistoricalDetail {
  source: 'api-football';
  historical: true;
  /** `null` = estas estadísticas nunca se cargaron. */
  statistics: HistoricalStatistics | null;
  /** `null` = la cronología nunca se cargó. */
  goals: HistoricalGoals | null;
}
