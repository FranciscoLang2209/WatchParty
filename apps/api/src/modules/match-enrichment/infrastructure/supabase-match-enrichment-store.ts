import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabasePersistenceError } from '../../matches/infrastructure/supabase-persistence-error.js';
import {
  ENRICHMENT_PROVIDER,
  type EnrichmentMatchRef,
  type GoalEvent,
  type GoalEventKind,
  type GoalsCoverage,
  type HistoricalDetail,
  type MatchEnrichmentPayload,
  type MatchEnrichmentReader,
  type MatchEnrichmentStore,
  type StatisticsCoverage,
  type StoredEnrichmentState,
  type TeamSide,
  type TeamStatistics,
} from '../domain/match-enrichment.js';

// Código de Postgres para «el valor no tiene la forma del tipo esperado» (p. ej. un uuid inválido).
const POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02';

const STATISTICS_COVERAGES: readonly StatisticsCoverage[] = ['complete', 'partial'];
const GOALS_COVERAGES: readonly GoalsCoverage[] = ['complete', 'incomplete'];
const GOAL_KINDS: readonly GoalEventKind[] = [
  'goal',
  'own_goal',
  'penalty_goal',
  'goal_cancelled',
  'shootout_goal',
];
const SIDES: readonly TeamSide[] = ['home', 'away'];

interface MatchRefRow {
  id: string;
  status: string;
  kickoff_at: string;
  competition_external_id: string;
  home_score: number | null;
  away_score: number | null;
  home_team: { name: string } | null;
  away_team: { name: string } | null;
}

interface EnrichmentRow {
  statistics_coverage: string | null;
  statistics_fetched_at: string | null;
  goals_coverage: string | null;
  goals_fetched_at: string | null;
}

interface StatisticsRow {
  side: string;
  possession_pct: number | string | null;
  total_shots: number | null;
  shots_on_goal: number | null;
  corner_kicks: number | null;
  fouls: number | null;
}

interface GoalRow {
  kind: string;
  side: string;
  player_name: string | null;
  minute: number;
  extra_minute: number | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTeamStatistics(row: StatisticsRow | undefined): TeamStatistics {
  return {
    possessionPct: row ? toNumberOrNull(row.possession_pct) : null,
    totalShots: row?.total_shots ?? null,
    shotsOnGoal: row?.shots_on_goal ?? null,
    cornerKicks: row?.corner_kicks ?? null,
    fouls: row?.fouls ?? null,
  };
}

function toGoalEvent(row: GoalRow): GoalEvent {
  if (!oneOf(GOAL_KINDS, row.kind) || !oneOf(SIDES, row.side)) {
    throw new SupabasePersistenceError('Un evento de gol guardado no cumple el contrato.');
  }

  return {
    kind: row.kind,
    side: row.side,
    playerName: row.player_name,
    minute: row.minute,
    extraMinute: row.extra_minute,
  };
}

/**
 * Persistencia del enriquecimiento histórico respaldada por Supabase. Lee y escribe con la
 * service_role key del backend; nunca desde el frontend. La escritura pasa por una única función
 * de base de datos (`apply_match_enrichment`) para que cada partido se guarde de forma atómica.
 */
export class SupabaseMatchEnrichmentStore implements MatchEnrichmentStore, MatchEnrichmentReader {
  constructor(private readonly client: SupabaseClient) {}

  async findMatchForEnrichment(matchId: string): Promise<EnrichmentMatchRef | null> {
    const { data, error } = await this.client
      .from('matches')
      .select(
        'id, status, kickoff_at, competition_external_id, home_score, away_score, home_team:teams!matches_home_team_id_fkey(name), away_team:teams!matches_away_team_id_fkey(name)',
      )
      .eq('id', matchId)
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_INVALID_TEXT_REPRESENTATION) return null;
      throw new SupabasePersistenceError(`No se pudo buscar el partido ${matchId}.`, error);
    }

    if (!data) return null;

    const row = data as unknown as MatchRefRow;
    if (!row.home_team || !row.away_team) {
      throw new SupabasePersistenceError(
        `El partido ${row.id} no pudo resolver sus equipos desde la relación.`,
      );
    }

    return {
      id: row.id,
      status: row.status,
      kickoffAt: new Date(row.kickoff_at).toISOString(),
      homeTeamName: row.home_team.name,
      awayTeamName: row.away_team.name,
      competitionExternalId: row.competition_external_id,
      score:
        typeof row.home_score === 'number' && typeof row.away_score === 'number'
          ? { home: row.home_score, away: row.away_score }
          : null,
    };
  }

  async findMatchIdByFixture(provider: string, fixtureId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('match_provider_links')
      .select('match_id')
      .eq('provider', provider)
      .eq('external_fixture_id', fixtureId)
      .maybeSingle();

    if (error) {
      throw new SupabasePersistenceError('No se pudo consultar la vinculación del fixture.', error);
    }

    return data ? (data as { match_id: string }).match_id : null;
  }

  async findFixtureByMatch(provider: string, matchId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('match_provider_links')
      .select('external_fixture_id')
      .eq('provider', provider)
      .eq('match_id', matchId)
      .maybeSingle();

    if (error) {
      throw new SupabasePersistenceError('No se pudo consultar la vinculación del partido.', error);
    }

    return data ? (data as { external_fixture_id: string }).external_fixture_id : null;
  }

  async getStoredState(provider: string, matchId: string): Promise<StoredEnrichmentState> {
    const row = await this.readEnrichmentRow(provider, matchId);

    return {
      statisticsCoverage: oneOf(STATISTICS_COVERAGES, row?.statistics_coverage)
        ? row.statistics_coverage
        : null,
      goalsCoverage: oneOf(GOALS_COVERAGES, row?.goals_coverage) ? row.goals_coverage : null,
    };
  }

  async countMatches(): Promise<number> {
    const { count, error } = await this.client
      .from('matches')
      .select('id', { count: 'exact', head: true });

    if (error || count === null) {
      throw new SupabasePersistenceError('No se pudo contar los partidos.', error ?? undefined);
    }

    return count;
  }

  async saveEnrichment(input: {
    matchId: string;
    provider: string;
    fixtureId: string;
    fetchedAt: string;
    payload: MatchEnrichmentPayload;
  }): Promise<void> {
    const { payload } = input;

    const { error } = await this.client.rpc('apply_match_enrichment', {
      p_match_id: input.matchId,
      p_provider: input.provider,
      p_external_fixture_id: input.fixtureId,
      p_fetched_at: input.fetchedAt,
      p_statistics: payload.statistics
        ? {
            coverage: payload.statistics.coverage,
            home: toStatisticsJson(payload.statistics.home),
            away: toStatisticsJson(payload.statistics.away),
          }
        : null,
      p_goals: payload.goals
        ? {
            coverage: payload.goals.coverage,
            events: payload.goals.events.map((event) => ({
              kind: event.kind,
              side: event.side,
              player_name: event.playerName,
              minute: event.minute,
              extra_minute: event.extraMinute,
            })),
          }
        : null,
    });

    if (error) {
      throw new SupabasePersistenceError(
        `No se pudo guardar el enriquecimiento del partido ${input.matchId}.`,
        error,
      );
    }
  }

  async findHistoricalDetail(matchId: string): Promise<HistoricalDetail | null> {
    const row = await this.readEnrichmentRow(ENRICHMENT_PROVIDER, matchId);
    if (row === null) return null;

    const statistics = await this.readStatistics(matchId, row);
    const goals = await this.readGoals(matchId, row);

    // Una fila sin ninguna parte cargada (sólo el vínculo) equivale a «sin enriquecer».
    if (statistics === null && goals === null) return null;

    return { source: ENRICHMENT_PROVIDER, historical: true, statistics, goals };
  }

  private async readEnrichmentRow(
    provider: string,
    matchId: string,
  ): Promise<EnrichmentRow | null> {
    const { data, error } = await this.client
      .from('match_enrichment')
      .select('statistics_coverage, statistics_fetched_at, goals_coverage, goals_fetched_at')
      .eq('match_id', matchId)
      .eq('provider', provider)
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_INVALID_TEXT_REPRESENTATION) return null;
      throw new SupabasePersistenceError(
        'No se pudo leer el detalle histórico del partido.',
        error,
      );
    }

    return (data as EnrichmentRow | null) ?? null;
  }

  private async readStatistics(
    matchId: string,
    row: EnrichmentRow,
  ): Promise<HistoricalDetail['statistics']> {
    if (
      !oneOf(STATISTICS_COVERAGES, row.statistics_coverage) ||
      row.statistics_fetched_at === null
    ) {
      return null;
    }

    const { data, error } = await this.client
      .from('match_team_statistics')
      .select('side, possession_pct, total_shots, shots_on_goal, corner_kicks, fouls')
      .eq('match_id', matchId)
      .eq('provider', ENRICHMENT_PROVIDER);

    if (error) {
      throw new SupabasePersistenceError(
        'No se pudieron leer las estadísticas del partido.',
        error,
      );
    }

    const rows = (data ?? []) as StatisticsRow[];

    return {
      coverage: row.statistics_coverage,
      fetchedAt: new Date(row.statistics_fetched_at).toISOString(),
      home: toTeamStatistics(rows.find((r) => r.side === 'home')),
      away: toTeamStatistics(rows.find((r) => r.side === 'away')),
    };
  }

  private async readGoals(matchId: string, row: EnrichmentRow): Promise<HistoricalDetail['goals']> {
    if (!oneOf(GOALS_COVERAGES, row.goals_coverage) || row.goals_fetched_at === null) return null;

    const { data, error } = await this.client
      .from('match_goal_events')
      .select('kind, side, player_name, minute, extra_minute')
      .eq('match_id', matchId)
      .eq('provider', ENRICHMENT_PROVIDER)
      .order('position', { ascending: true });

    if (error) {
      throw new SupabasePersistenceError('No se pudieron leer los goles del partido.', error);
    }

    return {
      coverage: row.goals_coverage,
      fetchedAt: new Date(row.goals_fetched_at).toISOString(),
      events: ((data ?? []) as GoalRow[]).map(toGoalEvent),
    };
  }
}

function toStatisticsJson(stats: TeamStatistics) {
  return {
    possession_pct: stats.possessionPct,
    total_shots: stats.totalShots,
    shots_on_goal: stats.shotsOnGoal,
    corner_kicks: stats.cornerKicks,
    fouls: stats.fouls,
  };
}
