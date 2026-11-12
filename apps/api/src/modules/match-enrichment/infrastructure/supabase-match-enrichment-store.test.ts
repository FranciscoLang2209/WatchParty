import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabasePersistenceError } from '../../matches/infrastructure/supabase-persistence-error.js';
import { SupabaseMatchEnrichmentStore } from './supabase-match-enrichment-store.js';

type FakeResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

function makeBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (value: FakeResult) => unknown) => resolve(result),
  };
  return builder;
}

function makeClient(
  tables: Record<string, FakeResult>,
  rpcResult: FakeResult = { data: null, error: null },
) {
  const builders: Record<string, ReturnType<typeof makeBuilder>> = {};
  const from = vi.fn((table: string) => {
    const result = tables[table];
    if (!result) throw new Error(`Tabla inesperada: ${table}`);
    builders[table] = makeBuilder(result);
    return builders[table]!;
  });
  const rpc = vi.fn(async () => rpcResult);

  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, builders };
}

const MATCH_ID = '3f9c0c8e-1c1e-4a62-8f64-0a3f6f1a2b10';

describe('SupabaseMatchEnrichmentStore — escritura', () => {
  it('guarda con UNA sola llamada atómica a la función de base de datos', async () => {
    const { client, rpc, from } = makeClient({});
    const store = new SupabaseMatchEnrichmentStore(client);

    await store.saveEnrichment({
      matchId: MATCH_ID,
      provider: 'api-football',
      fixtureId: '1145512',
      fetchedAt: '2026-11-12T15:00:00.000Z',
      payload: {
        statistics: {
          coverage: 'partial',
          home: {
            possessionPct: 58,
            totalShots: 15,
            shotsOnGoal: 0,
            cornerKicks: null,
            fouls: null,
          },
          away: {
            possessionPct: 42,
            totalShots: null,
            shotsOnGoal: null,
            cornerKicks: null,
            fouls: null,
          },
        },
        goals: {
          coverage: 'complete',
          events: [
            { kind: 'goal', side: 'home', playerName: 'N. Williams', minute: 45, extraMinute: 2 },
            {
              kind: 'goal_cancelled',
              side: 'away',
              playerName: null,
              minute: 60,
              extraMinute: null,
            },
          ],
        },
      },
    });

    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('apply_match_enrichment', {
      p_match_id: MATCH_ID,
      p_provider: 'api-football',
      p_external_fixture_id: '1145512',
      p_fetched_at: '2026-11-12T15:00:00.000Z',
      p_statistics: {
        coverage: 'partial',
        // Un 0 viaja como 0 y la ausencia como null: nunca se mezclan.
        home: {
          possession_pct: 58,
          total_shots: 15,
          shots_on_goal: 0,
          corner_kicks: null,
          fouls: null,
        },
        away: {
          possession_pct: 42,
          total_shots: null,
          shots_on_goal: null,
          corner_kicks: null,
          fouls: null,
        },
      },
      p_goals: {
        coverage: 'complete',
        events: [
          { kind: 'goal', side: 'home', player_name: 'N. Williams', minute: 45, extra_minute: 2 },
          {
            kind: 'goal_cancelled',
            side: 'away',
            player_name: null,
            minute: 60,
            extra_minute: null,
          },
        ],
      },
    });
  });

  it('una parte ausente viaja como null para que la base no la toque', async () => {
    const { client, rpc } = makeClient({});
    const store = new SupabaseMatchEnrichmentStore(client);

    await store.saveEnrichment({
      matchId: MATCH_ID,
      provider: 'api-football',
      fixtureId: '1',
      fetchedAt: '2026-11-12T15:00:00.000Z',
      payload: {},
    });

    expect(rpc).toHaveBeenCalledWith(
      'apply_match_enrichment',
      expect.objectContaining({ p_statistics: null, p_goals: null }),
    );
  });

  it('un error de la base se traduce a un error de persistencia sin filtrar el detalle', async () => {
    const { client } = makeClient({}, { data: null, error: { message: 'detalle interno de SQL' } });
    const store = new SupabaseMatchEnrichmentStore(client);

    const promise = store.saveEnrichment({
      matchId: MATCH_ID,
      provider: 'api-football',
      fixtureId: '1',
      fetchedAt: '2026-11-12T15:00:00.000Z',
      payload: {},
    });

    await expect(promise).rejects.toBeInstanceOf(SupabasePersistenceError);
    await expect(promise).rejects.not.toThrow('detalle interno de SQL');
  });
});

describe('SupabaseMatchEnrichmentStore — verificación de partidos y vínculos', () => {
  it('lee el partido con sus equipos, competición, inicio UTC y marcador', async () => {
    const { client } = makeClient({
      matches: {
        data: {
          id: MATCH_ID,
          provider: 'football-data-org',
          status: 'finished',
          kickoff_at: '2024-07-14T19:00:00+00:00',
          competition_external_id: '2018',
          home_score: 2,
          away_score: 1,
          home_team: { name: 'Spain' },
          away_team: { name: 'England' },
        },
        error: null,
      },
    });

    expect(await new SupabaseMatchEnrichmentStore(client).findMatchForEnrichment(MATCH_ID)).toEqual(
      {
        id: MATCH_ID,
        provider: 'football-data-org',
        status: 'finished',
        kickoffAt: '2024-07-14T19:00:00.000Z',
        homeTeamName: 'Spain',
        awayTeamName: 'England',
        competitionExternalId: '2018',
        score: { home: 2, away: 1 },
      },
    );
  });

  it('un partido sin marcador lo informa como null, nunca 0–0', async () => {
    const { client } = makeClient({
      matches: {
        data: {
          id: MATCH_ID,
          provider: 'football-data-org',
          status: 'finished',
          kickoff_at: '2024-07-14T19:00:00+00:00',
          competition_external_id: '2018',
          home_score: null,
          away_score: null,
          home_team: { name: 'Spain' },
          away_team: { name: 'England' },
        },
        error: null,
      },
    });

    const match = await new SupabaseMatchEnrichmentStore(client).findMatchForEnrichment(MATCH_ID);

    expect(match?.score).toBeNull();
  });

  it('un partido inexistente o un id que no es UUID devuelve null', async () => {
    const inexistente = makeClient({ matches: { data: null, error: null } });
    const invalido = makeClient({
      matches: { data: null, error: { message: 'x', code: '22P02' } },
    });

    expect(
      await new SupabaseMatchEnrichmentStore(inexistente.client).findMatchForEnrichment(MATCH_ID),
    ).toBeNull();
    expect(
      await new SupabaseMatchEnrichmentStore(invalido.client).findMatchForEnrichment('no-uuid'),
    ).toBeNull();
  });

  it('consulta los vínculos por proveedor y fixture, y por proveedor y partido', async () => {
    const porFixture = makeClient({
      match_provider_links: { data: { match_id: MATCH_ID }, error: null },
    });
    const porPartido = makeClient({
      match_provider_links: { data: { external_fixture_id: '1145512' }, error: null },
    });

    expect(
      await new SupabaseMatchEnrichmentStore(porFixture.client).findMatchIdByFixture(
        'api-football',
        '1145512',
      ),
    ).toBe(MATCH_ID);
    expect(porFixture.builders.match_provider_links?.eq).toHaveBeenCalledWith(
      'provider',
      'api-football',
    );
    expect(porFixture.builders.match_provider_links?.eq).toHaveBeenCalledWith(
      'external_fixture_id',
      '1145512',
    );
    expect(
      await new SupabaseMatchEnrichmentStore(porPartido.client).findFixtureByMatch(
        'api-football',
        MATCH_ID,
      ),
    ).toBe('1145512');
  });

  it('cuenta los partidos', async () => {
    const { client } = makeClient({ matches: { data: null, error: null, count: 42 } });

    expect(await new SupabaseMatchEnrichmentStore(client).countMatches()).toBe(42);
  });

  it('el estado guardado ignora coberturas fuera del contrato', async () => {
    const { client } = makeClient({
      match_enrichment: {
        data: {
          statistics_coverage: 'complete',
          statistics_fetched_at: '2026-11-12T15:00:00Z',
          goals_coverage: 'raro',
          goals_fetched_at: '2026-11-12T15:00:00Z',
        },
        error: null,
      },
      match_team_statistics: {
        data: [
          {
            possession_pct: '58.00',
            total_shots: 15,
            shots_on_goal: 0,
            corner_kicks: null,
            fouls: null,
          },
          {
            possession_pct: '42.00',
            total_shots: null,
            shots_on_goal: null,
            corner_kicks: 0,
            fouls: 14,
          },
        ],
        error: null,
      },
    });

    expect(
      await new SupabaseMatchEnrichmentStore(client).getStoredState('api-football', MATCH_ID),
    ).toEqual({
      statisticsCoverage: 'complete',
      // Cuenta las métricas con valor: el 0 cuenta, el null no.
      statisticsValueCount: 6,
      goalsCoverage: null,
      goalsEventCount: 0,
    });
  });

  it('el estado guardado cuenta los eventos de gol cuando hay cronología', async () => {
    const { client } = makeClient({
      match_enrichment: {
        data: {
          statistics_coverage: null,
          statistics_fetched_at: null,
          goals_coverage: 'incomplete',
          goals_fetched_at: '2026-11-12T15:00:00Z',
        },
        error: null,
      },
      match_goal_events: { data: null, error: null, count: 3 },
    });

    expect(
      await new SupabaseMatchEnrichmentStore(client).getStoredState('api-football', MATCH_ID),
    ).toEqual({
      statisticsCoverage: null,
      statisticsValueCount: 0,
      goalsCoverage: 'incomplete',
      goalsEventCount: 3,
    });
  });
});

describe('SupabaseMatchEnrichmentStore — lectura del detalle histórico', () => {
  const ENRICHMENT_ROW = {
    statistics_coverage: 'complete',
    statistics_fetched_at: '2026-11-12T15:00:00+00:00',
    goals_coverage: 'complete',
    goals_fetched_at: '2026-11-12T15:00:01+00:00',
  };

  it('arma estadísticas por lado y goles en el orden de position', async () => {
    const { client, builders } = makeClient({
      match_enrichment: { data: ENRICHMENT_ROW, error: null },
      match_team_statistics: {
        data: [
          {
            side: 'away',
            possession_pct: '42.00',
            total_shots: 9,
            shots_on_goal: 0,
            corner_kicks: 0,
            fouls: 14,
          },
          {
            side: 'home',
            possession_pct: '58.00',
            total_shots: 15,
            shots_on_goal: 7,
            corner_kicks: 6,
            fouls: 11,
          },
        ],
        error: null,
      },
      match_goal_events: {
        data: [
          { kind: 'goal', side: 'home', player_name: 'N. Williams', minute: 45, extra_minute: 2 },
          {
            kind: 'shootout_goal',
            side: 'away',
            player_name: null,
            minute: 120,
            extra_minute: null,
          },
        ],
        error: null,
      },
    });

    const detail = await new SupabaseMatchEnrichmentStore(client).findHistoricalDetail(MATCH_ID);

    expect(detail).toEqual({
      source: 'api-football',
      historical: true,
      statistics: {
        coverage: 'complete',
        fetchedAt: '2026-11-12T15:00:00.000Z',
        home: { possessionPct: 58, totalShots: 15, shotsOnGoal: 7, cornerKicks: 6, fouls: 11 },
        // Los ceros reales se conservan.
        away: { possessionPct: 42, totalShots: 9, shotsOnGoal: 0, cornerKicks: 0, fouls: 14 },
      },
      goals: {
        coverage: 'complete',
        fetchedAt: '2026-11-12T15:00:01.000Z',
        events: [
          { kind: 'goal', side: 'home', playerName: 'N. Williams', minute: 45, extraMinute: 2 },
          { kind: 'shootout_goal', side: 'away', playerName: null, minute: 120, extraMinute: null },
        ],
      },
    });
    expect(builders.match_goal_events?.order).toHaveBeenCalledWith('position', { ascending: true });
  });

  it('un partido nunca enriquecido devuelve null', async () => {
    const { client } = makeClient({ match_enrichment: { data: null, error: null } });

    expect(
      await new SupabaseMatchEnrichmentStore(client).findHistoricalDetail(MATCH_ID),
    ).toBeNull();
  });

  it('un partido sólo vinculado (sin ninguna parte cargada) equivale a «sin enriquecer»', async () => {
    const { client } = makeClient({
      match_enrichment: {
        data: {
          statistics_coverage: null,
          statistics_fetched_at: null,
          goals_coverage: null,
          goals_fetched_at: null,
        },
        error: null,
      },
    });

    expect(
      await new SupabaseMatchEnrichmentStore(client).findHistoricalDetail(MATCH_ID),
    ).toBeNull();
  });

  it('con sólo estadísticas, los goles quedan en null (sin dato, no lista vacía)', async () => {
    const { client } = makeClient({
      match_enrichment: {
        data: { ...ENRICHMENT_ROW, goals_coverage: null, goals_fetched_at: null },
        error: null,
      },
      match_team_statistics: { data: [], error: null },
    });

    const detail = await new SupabaseMatchEnrichmentStore(client).findHistoricalDetail(MATCH_ID);

    expect(detail?.goals).toBeNull();
    expect(detail?.statistics?.home).toEqual({
      possessionPct: null,
      totalShots: null,
      shotsOnGoal: null,
      cornerKicks: null,
      fouls: null,
    });
  });

  it('un evento guardado fuera del contrato es un error, no se muestra', async () => {
    const { client } = makeClient({
      match_enrichment: {
        data: { ...ENRICHMENT_ROW, statistics_coverage: null, statistics_fetched_at: null },
        error: null,
      },
      match_goal_events: {
        data: [{ kind: 'raro', side: 'home', player_name: null, minute: 1, extra_minute: null }],
        error: null,
      },
    });

    await expect(
      new SupabaseMatchEnrichmentStore(client).findHistoricalDetail(MATCH_ID),
    ).rejects.toBeInstanceOf(SupabasePersistenceError);
  });

  it('un error de la base se propaga: nunca se sustituye por «sin datos»', async () => {
    const { client } = makeClient({
      match_enrichment: { data: null, error: { message: 'caída' } },
    });

    await expect(
      new SupabaseMatchEnrichmentStore(client).findHistoricalDetail(MATCH_ID),
    ).rejects.toBeInstanceOf(SupabasePersistenceError);
  });
});
