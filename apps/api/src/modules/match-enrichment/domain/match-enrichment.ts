/**
 * Enriquecimiento histórico de partidos ya guardados con estadísticas y goles de un proveedor
 * complementario. El partido (su UUID, su `(provider, external_id)` y su marcador) no cambia:
 * todo lo que se agrega cuelga de `matches.id`.
 */

/** Único proveedor complementario soportado hoy. */
export const ENRICHMENT_PROVIDER = 'api-football';

export type TeamSide = 'home' | 'away';

/**
 * Métricas por equipo. Cada una es `null` cuando el proveedor no la informó: un `null` es
 * «sin dato» y NUNCA se convierte en cero (un `0` es un dato real).
 */
export interface TeamStatistics {
  /** Porcentaje 0–100. */
  possessionPct: number | null;
  totalShots: number | null;
  shotsOnGoal: number | null;
  cornerKicks: number | null;
  fouls: number | null;
}

/** `complete`: los dos equipos y las cinco métricas. `partial`: falta o se descartó algo. */
export type StatisticsCoverage = 'complete' | 'partial';

export interface MatchStatistics {
  coverage: StatisticsCoverage;
  home: TeamStatistics;
  away: TeamStatistics;
}

/**
 * `goal`, `own_goal` y `penalty_goal` son goles del juego. `goal_cancelled` es una anulación (no
 * suma al marcador). `shootout_goal` es un gol de la tanda de penales (no es un gol del juego).
 */
export type GoalEventKind =
  'goal' | 'own_goal' | 'penalty_goal' | 'goal_cancelled' | 'shootout_goal';

export interface GoalEvent {
  kind: GoalEventKind;
  /** Equipo al que se le acredita. En un gol en contra, el equipo beneficiado. */
  side: TeamSide;
  /** `null` cuando el proveedor no informó el autor. */
  playerName: string | null;
  minute: number;
  /** Minutos de añadido (45+2 → minute 45, extraMinute 2); `null` si no hay. */
  extraMinute: number | null;
}

/**
 * `complete`: la cronología coincide con el marcador del partido (o es un 0–0 real).
 * `incomplete`: no se pudo comprobar o no coincide; nunca se presenta como cronología completa.
 */
export type GoalsCoverage = 'complete' | 'incomplete';

export interface MatchGoals {
  coverage: GoalsCoverage;
  /** En el orden en que los entrega el proveedor (cronológico). */
  events: readonly GoalEvent[];
}

/** Lo que se guarda de un partido: cada parte es opcional y se reemplaza por separado. */
export interface MatchEnrichmentPayload {
  statistics?: MatchStatistics;
  goals?: MatchGoals;
}

/** Estado persistido por parte: qué cobertura tiene y cuándo se consultó. */
export interface StoredEnrichmentState {
  statisticsCoverage: StatisticsCoverage | null;
  goalsCoverage: GoalsCoverage | null;
}

/** Lo que el importador necesita saber del partido interno para verificar una correspondencia. */
export interface EnrichmentMatchRef {
  id: string;
  status: string;
  kickoffAt: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionExternalId: string;
  score: { home: number; away: number } | null;
}

/**
 * Detalle histórico tal como lo expone la API. `statistics` y `goals` son `null` cuando esa parte
 * nunca se cargó: la pantalla lo muestra como «sin dato», no como ceros ni como lista vacía.
 */
export interface HistoricalDetail {
  source: typeof ENRICHMENT_PROVIDER;
  /** Siempre `true`: son datos cerrados de un partido terminado, sin actualización en vivo. */
  historical: true;
  statistics: (MatchStatistics & { fetchedAt: string }) | null;
  goals: (MatchGoals & { fetchedAt: string }) | null;
}

/** Puerto de LECTURA que usa la API HTTP. */
export interface MatchEnrichmentReader {
  /** `null` cuando el partido nunca se enriqueció. */
  findHistoricalDetail(matchId: string): Promise<HistoricalDetail | null>;
}

/** Puerto de ESCRITURA que usa el comando administrativo. */
export interface MatchEnrichmentStore {
  findMatchForEnrichment(matchId: string): Promise<EnrichmentMatchRef | null>;
  /** Partido al que ya pertenece ese fixture externo, si alguno. */
  findMatchIdByFixture(provider: string, fixtureId: string): Promise<string | null>;
  /** Fixture externo al que ya está vinculado el partido, si alguno. */
  findFixtureByMatch(provider: string, matchId: string): Promise<string | null>;
  getStoredState(provider: string, matchId: string): Promise<StoredEnrichmentState>;
  /** Cantidad total de partidos: el enriquecimiento nunca debe cambiarla. */
  countMatches(): Promise<number>;
  /**
   * Vincula (si no lo estaba) y guarda, en una sola operación atómica, las partes presentes del
   * payload. Una parte ausente no se toca.
   */
  saveEnrichment(input: {
    matchId: string;
    provider: string;
    fixtureId: string;
    fetchedAt: string;
    payload: MatchEnrichmentPayload;
  }): Promise<void>;
}
