import type {
  GoalEvent,
  GoalEventKind,
  GoalsCoverage,
  HistoricalDetail,
  StatisticsCoverage,
  TeamStatistics,
} from '../domain/match-enrichment.js';

export interface GoalEntryResponse {
  kind: GoalEventKind;
  side: 'home' | 'away';
  /** `null` cuando el proveedor no informó el autor. */
  playerName: string | null;
  minute: number;
  /** Añadido (45+2 → minute 45, extraMinute 2); `null` si no hay. */
  extraMinute: number | null;
}

export interface HistoricalDetailResponse {
  source: 'api-football';
  /** Siempre `true`: datos cerrados de un partido terminado, sin actualización en vivo. */
  historical: true;
  /** `null` = estas estadísticas nunca se cargaron (sin dato, no ceros). */
  statistics: {
    coverage: StatisticsCoverage;
    fetchedAt: string;
    home: TeamStatistics;
    away: TeamStatistics;
  } | null;
  /**
   * `null` = la cronología nunca se cargó. `goals` son sólo los goles del juego, `cancelled` las
   * anulaciones y `shootout` la tanda de penales: son listas separadas.
   */
  goals: {
    coverage: GoalsCoverage;
    fetchedAt: string;
    goals: GoalEntryResponse[];
    cancelled: GoalEntryResponse[];
    shootout: GoalEntryResponse[];
  } | null;
}

function toEntry(event: GoalEvent): GoalEntryResponse {
  return {
    kind: event.kind,
    side: event.side,
    playerName: event.playerName,
    minute: event.minute,
    extraMinute: event.extraMinute,
  };
}

export function toHistoricalDetailResponse(detail: HistoricalDetail): HistoricalDetailResponse {
  return {
    source: detail.source,
    historical: true,
    statistics: detail.statistics
      ? {
          coverage: detail.statistics.coverage,
          fetchedAt: detail.statistics.fetchedAt,
          home: detail.statistics.home,
          away: detail.statistics.away,
        }
      : null,
    goals: detail.goals
      ? {
          coverage: detail.goals.coverage,
          fetchedAt: detail.goals.fetchedAt,
          goals: detail.goals.events
            .filter(
              (event) =>
                event.kind === 'goal' || event.kind === 'own_goal' || event.kind === 'penalty_goal',
            )
            .map(toEntry),
          cancelled: detail.goals.events
            .filter((event) => event.kind === 'goal_cancelled')
            .map(toEntry),
          shootout: detail.goals.events
            .filter((event) => event.kind === 'shootout_goal')
            .map(toEntry),
        }
      : null,
  };
}
