import { describe, it, expect, vi } from 'vitest';
import type { ApiFootballFetchOutcome } from '../../matches/infrastructure/api-football-client.js';
import type { QuotaReservationResult } from '../../matches/domain/match-store.js';
import type {
  EnrichmentMatchRef,
  MatchEnrichmentPayload,
  MatchEnrichmentStore,
  StoredEnrichmentState,
} from '../domain/match-enrichment.js';
import {
  createRequestGate,
  enrichMatchesBatch,
  formatEnrichBatchTable,
  type EnrichmentClient,
} from './enrich-matches-batch.js';

const HOME = 9;
const AWAY = 10;
const M1 = '3f9c0c8e-1c1e-4a62-8f64-0a3f6f1a2b10';
const M2 = '7a2d1b50-5c3e-4f10-9a77-2d9e4c8b1f33';
const M3 = '0b8e6f2a-9d41-4c7a-8e55-6a1f3d2c9b04';

// ---------------------------------------------------------------------------------------------
// Dobles
// ---------------------------------------------------------------------------------------------

function ok(response: unknown[], headers: Record<string, string> = {}): ApiFootballFetchOutcome {
  return {
    kind: 'response',
    status: 200,
    ok: true,
    body: { errors: [], results: response.length, response },
    paging: undefined,
    headers,
  };
}

function status(code: number, headers: Record<string, string> = {}): ApiFootballFetchOutcome {
  return { kind: 'response', status: code, ok: false, body: {}, paging: undefined, headers };
}

const fixtureOk = (id: number, overrides: Record<string, unknown> = {}) =>
  ok([
    {
      fixture: { id, date: '2024-07-14T19:00:00+00:00', status: { short: 'FT' } },
      league: { id: 4, name: 'Euro Championship', season: 2024 },
      teams: { home: { id: HOME, name: 'Spain' }, away: { id: AWAY, name: 'England' } },
      goals: { home: 2, away: 1 },
      ...overrides,
    },
  ]);

const team = (id: number, values: Record<string, unknown>) => ({
  team: { id },
  statistics: Object.entries(values).map(([type, value]) => ({ type, value })),
});

const FULL_STATS = ok([
  team(HOME, {
    'Ball Possession': '58%',
    'Total Shots': 15,
    'Shots on Goal': 7,
    'Corner Kicks': 6,
    Fouls: 11,
  }),
  team(AWAY, {
    'Ball Possession': '42%',
    'Total Shots': 9,
    'Shots on Goal': 3,
    'Corner Kicks': 0,
    Fouls: 14,
  }),
]);

const PARTIAL_STATS = ok([
  team(HOME, { 'Ball Possession': '58%', 'Total Shots': 15 }),
  team(AWAY, { 'Ball Possession': '42%', 'Total Shots': 9 }),
]);

const goal = (teamId: number, elapsed: number, extra: number | null = null) => ({
  time: { elapsed, extra },
  team: { id: teamId },
  player: { name: 'Jugador' },
  type: 'Goal',
  detail: 'Normal Goal',
  comments: null,
});

const FULL_EVENTS = ok([goal(HOME, 47), goal(AWAY, 73), goal(HOME, 90, 4)]);
const PARTIAL_EVENTS = ok([goal(HOME, 47), goal(AWAY, 73)]);

interface Script {
  fixture?: ApiFootballFetchOutcome | ApiFootballFetchOutcome[];
  statistics?: ApiFootballFetchOutcome | ApiFootballFetchOutcome[];
  events?: ApiFootballFetchOutcome | ApiFootballFetchOutcome[];
}

function scripted(byFixture: Record<number, Script>) {
  const calls: string[] = [];

  function next(
    value: ApiFootballFetchOutcome | ApiFootballFetchOutcome[] | undefined,
    cursor: Map<string, number>,
    key: string,
  ): ApiFootballFetchOutcome {
    if (value === undefined) return { kind: 'network-error', message: 'sin guion' };
    if (!Array.isArray(value)) return value;

    const index = cursor.get(key) ?? 0;
    cursor.set(key, index + 1);

    return value[Math.min(index, value.length - 1)]!;
  }

  const cursor = new Map<string, number>();

  const client: EnrichmentClient = {
    async fetchFixtureById({ fixtureId }) {
      calls.push(`fixture:${fixtureId}`);
      return next(byFixture[fixtureId]?.fixture, cursor, `fixture:${fixtureId}`);
    },
    async fetchFixtureStatistics({ fixtureId }) {
      calls.push(`statistics:${fixtureId}`);
      return next(byFixture[fixtureId]?.statistics, cursor, `statistics:${fixtureId}`);
    },
    async fetchFixtureEvents({ fixtureId }) {
      calls.push(`events:${fixtureId}`);
      return next(byFixture[fixtureId]?.events, cursor, `events:${fixtureId}`);
    },
  };

  return { client, calls };
}

interface StoredRows {
  fixtureId: string;
  statistics: MatchEnrichmentPayload['statistics'] | null;
  goals: MatchEnrichmentPayload['goals'] | null;
}

class FakeEnrichmentStore implements MatchEnrichmentStore {
  matches = new Map<string, EnrichmentMatchRef>();
  links = new Map<string, StoredRows>(); // matchId → filas
  saves: { matchId: string; payload: MatchEnrichmentPayload }[] = [];
  failSave = false;

  addMatch(id: string, overrides: Partial<EnrichmentMatchRef> = {}) {
    this.matches.set(id, {
      id,
      status: 'finished',
      kickoffAt: '2024-07-14T19:00:00.000Z',
      homeTeamName: 'Spain',
      awayTeamName: 'England',
      competitionExternalId: '2018',
      score: { home: 2, away: 1 },
      ...overrides,
    });
  }

  async findMatchForEnrichment(matchId: string) {
    return this.matches.get(matchId) ?? null;
  }

  async findMatchIdByFixture(_provider: string, fixtureId: string) {
    for (const [matchId, rows] of this.links) if (rows.fixtureId === fixtureId) return matchId;
    return null;
  }

  async findFixtureByMatch(_provider: string, matchId: string) {
    return this.links.get(matchId)?.fixtureId ?? null;
  }

  async getStoredState(_provider: string, matchId: string): Promise<StoredEnrichmentState> {
    const rows = this.links.get(matchId);
    return {
      statisticsCoverage: rows?.statistics?.coverage ?? null,
      goalsCoverage: rows?.goals?.coverage ?? null,
    };
  }

  async countMatches() {
    return this.matches.size;
  }

  async saveEnrichment(input: {
    matchId: string;
    fixtureId: string;
    payload: MatchEnrichmentPayload;
  }) {
    if (this.failSave) throw new Error('falló la base');

    this.saves.push({ matchId: input.matchId, payload: input.payload });

    const rows = this.links.get(input.matchId) ?? {
      fixtureId: input.fixtureId,
      statistics: null,
      goals: null,
    };
    // Igual que la función de base de datos: una parte presente REEMPLAZA a la anterior (no se
    // acumula) y una ausente no se toca.
    if (input.payload.statistics) rows.statistics = input.payload.statistics;
    if (input.payload.goals) rows.goals = input.payload.goals;
    this.links.set(input.matchId, rows);
  }
}

function quota(limit = 80) {
  let reserved = 0;
  const reserveProviderQuotaUnit = vi.fn(async (): Promise<QuotaReservationResult> => {
    if (reserved >= limit) return { reserved: false, reservedCount: reserved };
    reserved += 1;
    return { reserved: true, reservedCount: reserved };
  });

  return { reserveProviderQuotaUnit, reservedCount: () => reserved };
}

function fakeClock() {
  let nowMs = Date.parse('2026-11-12T15:00:00.000Z');
  const sleeps: number[] = [];

  return {
    now: () => new Date(nowMs),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
  };
}

function setup(script: Record<number, Script>, quotaLimit = 80) {
  const store = new FakeEnrichmentStore();
  const provider = scripted(script);
  const q = quota(quotaLimit);
  const clock = fakeClock();

  return {
    store,
    calls: provider.calls,
    quota: q,
    clock,
    run: (
      entries: { matchId: string; fixtureId: number }[],
      options: { dryRun: boolean; dailyQuotaLimit?: number; perMinuteLimit?: number },
    ) =>
      enrichMatchesBatch({ client: provider.client, store, quota: q, clock }, entries, {
        dailyQuotaLimit: quotaLimit,
        ...options,
      }),
  };
}

const COMPLETE: Script = { fixture: fixtureOk(100), statistics: FULL_STATS, events: FULL_EVENTS };

// ---------------------------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------------------------

describe('enrichMatchesBatch — dry_run', () => {
  it('hace las consultas pero NO guarda nada, y reporta qué guardaría', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: true });

    expect(env.store.saves).toEqual([]);
    expect(env.store.links.size).toBe(0);
    expect(env.calls).toEqual(['fixture:100', 'statistics:100', 'events:100']);
    expect(report.entries[0]).toMatchObject({
      outcome: 'enriquecido',
      requests: 3,
      statistics: { status: 'guardaria', coverage: 'complete' },
      goals: { status: 'guardaria', coverage: 'complete' },
    });
    expect(report.dryRun).toBe(true);
    expect(report.exitCode).toBe(0);
  });

  it('las consultas del dry_run sí consumen cuota (cada pedido reserva una unidad)', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: true });

    expect(env.quota.reserveProviderQuotaUnit).toHaveBeenCalledTimes(3);
    expect(report.quota).toMatchObject({ requestsMade: 3, reservedToday: 3, dailyLimit: 80 });
  });
});

describe('enrichMatchesBatch — escritura', () => {
  it('vincula y guarda estadísticas y goles del partido existente, sin tocar la cantidad de partidos', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });
    const guardado = env.store.links.get(M1);

    expect(guardado?.fixtureId).toBe('100');
    expect(guardado?.statistics).toMatchObject({
      coverage: 'complete',
      home: { possessionPct: 58, totalShots: 15 },
      // Un cero real se guarda como 0.
      away: { cornerKicks: 0 },
    });
    expect(guardado?.goals?.events.map((e) => [e.minute, e.extraMinute, e.side])).toEqual([
      [47, null, 'home'],
      [73, null, 'away'],
      [90, 4, 'home'],
    ]);
    expect(report).toMatchObject({ matchesBefore: 1, matchesAfter: 1, exitCode: 0 });
    expect(report.entries[0]).toMatchObject({
      outcome: 'enriquecido',
      statistics: { status: 'guardado' },
      goals: { status: 'guardado' },
    });
  });

  it('repetir el lote no duplica eventos ni vínculos', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);

    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });
    const primera = JSON.parse(JSON.stringify(env.store.links.get(M1)));
    const segunda = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(JSON.parse(JSON.stringify(env.store.links.get(M1)))).toEqual(primera);
    expect(env.store.links.size).toBe(1);
    expect(env.store.links.get(M1)?.goals?.events).toHaveLength(3);
    expect(segunda).toMatchObject({ matchesBefore: 1, matchesAfter: 1, exitCode: 0 });
  });

  it('acepta una corrección válida: una respuesta igual de completa reemplaza a la guardada', async () => {
    const env = setup({
      100: {
        fixture: fixtureOk(100),
        statistics: [
          FULL_STATS,
          ok([
            team(HOME, {
              'Ball Possession': '60%',
              'Total Shots': 16,
              'Shots on Goal': 7,
              'Corner Kicks': 6,
              Fouls: 11,
            }),
            team(AWAY, {
              'Ball Possession': '40%',
              'Total Shots': 9,
              'Shots on Goal': 3,
              'Corner Kicks': 0,
              Fouls: 14,
            }),
          ]),
        ],
        events: FULL_EVENTS,
      },
    });
    env.store.addMatch(M1);

    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });
    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.store.links.get(M1)?.statistics?.home).toMatchObject({
      possessionPct: 60,
      totalShots: 16,
    });
  });

  it('un lote con varios partidos los procesa a todos', async () => {
    const env = setup({
      100: COMPLETE,
      200: { ...COMPLETE, fixture: fixtureOk(200) },
      300: { ...COMPLETE, fixture: fixtureOk(300) },
    });
    [M1, M2, M3].forEach((id) => env.store.addMatch(id));

    const report = await env.run(
      [
        { matchId: M1, fixtureId: 100 },
        { matchId: M2, fixtureId: 200 },
        { matchId: M3, fixtureId: 300 },
      ],
      { dryRun: false },
    );

    expect(report.totals).toEqual({ enriquecidos: 3, sinCobertura: 0, rechazados: 0, errores: 0 });
    expect(report.quota.requestsMade).toBe(9);
    expect(env.store.links.size).toBe(3);
  });

  it('un error al guardar se informa como error, no como «guardado»', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);
    env.store.failSave = true;

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(report.entries[0]).toMatchObject({
      outcome: 'error',
      statistics: { status: 'error' },
      goals: { status: 'error' },
    });
    expect(report.entries[0]?.reasons.join()).toContain('escritura');
    expect(report.exitCode).toBe(1);
  });
});

describe('enrichMatchesBatch — asociaciones rechazadas', () => {
  it('un matchId inexistente se rechaza sin consultar y sin crear el partido', async () => {
    const env = setup({ 100: COMPLETE });

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual([]);
    expect(env.store.matches.size).toBe(0);
    expect(report.entries[0]).toMatchObject({ outcome: 'rechazado', requests: 0 });
    expect(report.entries[0]?.reasons[0]).toContain('partido-inexistente');
    expect(report.exitCode).toBe(1);
  });

  it('un fixture ya vinculado a OTRO partido se rechaza sin consultar (asociación ambigua)', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);
    env.store.addMatch(M2);
    env.store.links.set(M2, { fixtureId: '100', statistics: null, goals: null });

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual([]);
    expect(report.entries[0]?.outcome).toBe('rechazado');
    expect(report.entries[0]?.reasons[0]).toContain('fixture-ya-vinculado');
    expect(env.store.links.has(M1)).toBe(false);
  });

  it('un partido ya vinculado a otro fixture no se re-vincula en silencio', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);
    env.store.links.set(M1, { fixtureId: '999', statistics: null, goals: null });

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual([]);
    expect(report.entries[0]?.reasons[0]).toContain('partido-ya-vinculado');
    expect(env.store.links.get(M1)?.fixtureId).toBe('999');
  });

  it('un fixture que no coincide (otra fecha) se rechaza tras una sola consulta y no gasta más cuota', async () => {
    const env = setup({
      100: {
        fixture: fixtureOk(100, {
          fixture: { id: 100, date: '2024-07-20T19:00:00+00:00', status: { short: 'FT' } },
        }),
      },
    });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual(['fixture:100']);
    expect(report.entries[0]).toMatchObject({ outcome: 'rechazado', requests: 1 });
    expect(report.entries[0]?.reasons[0]).toContain('fecha-distinta');
    expect(env.store.saves).toEqual([]);
  });

  it('equipos invertidos o distintos se rechazan y quedan en la evidencia', async () => {
    const env = setup({
      100: {
        fixture: fixtureOk(100, {
          teams: { home: { id: AWAY, name: 'England' }, away: { id: HOME, name: 'Spain' } },
          goals: { home: 1, away: 2 },
        }),
      },
    });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(report.entries[0]?.reasons.join()).toContain('orientacion-invertida');
    expect(report.entries[0]?.evidence.homeTeam).toEqual({
      internal: 'Spain',
      provider: 'England',
    });
  });

  it('un fixture inexistente en el proveedor se rechaza', async () => {
    const env = setup({ 100: { fixture: ok([]) } });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(report.entries[0]?.reasons[0]).toContain('fixture-inexistente');
  });
});

describe('enrichMatchesBatch — cobertura incompleta, sin cobertura y errores', () => {
  it('una respuesta sin estadísticas ni eventos es «sin cobertura»: guarda el vínculo y nada más, sin ceros', async () => {
    const env = setup({ 100: { fixture: fixtureOk(100), statistics: ok([]), events: ok([]) } });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(report.entries[0]).toMatchObject({
      outcome: 'sin-cobertura',
      statistics: { status: 'sin-cobertura' },
      goals: { status: 'sin-cobertura' },
    });
    expect(env.store.links.get(M1)).toMatchObject({ statistics: null, goals: null });
    expect(report.totals.sinCobertura).toBe(1);
    expect(report.exitCode).toBe(0);
  });

  it('estadísticas parciales se guardan marcadas como parciales', async () => {
    const env = setup({ 100: { ...COMPLETE, statistics: PARTIAL_STATS } });
    env.store.addMatch(M1);

    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.store.links.get(M1)?.statistics).toMatchObject({
      coverage: 'partial',
      home: { cornerKicks: null, fouls: null, totalShots: 15 },
    });
  });

  it('una respuesta incompleta NO pisa estadísticas completas ya confirmadas', async () => {
    const env = setup({
      100: {
        fixture: fixtureOk(100),
        statistics: [FULL_STATS, PARTIAL_STATS],
        events: FULL_EVENTS,
      },
    });
    env.store.addMatch(M1);
    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });
    const confirmadas = JSON.parse(JSON.stringify(env.store.links.get(M1)?.statistics));

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(JSON.parse(JSON.stringify(env.store.links.get(M1)?.statistics))).toEqual(confirmadas);
    expect(report.entries[0]?.statistics).toMatchObject({
      status: 'conservado',
      coverage: 'partial',
    });
  });

  it('una cronología incompleta NO pisa una cronología completa ya confirmada', async () => {
    const env = setup({
      100: {
        fixture: fixtureOk(100),
        statistics: FULL_STATS,
        events: [FULL_EVENTS, PARTIAL_EVENTS],
      },
    });
    env.store.addMatch(M1);
    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.store.links.get(M1)?.goals?.events).toHaveLength(3);
    expect(env.store.links.get(M1)?.goals?.coverage).toBe('complete');
    expect(report.entries[0]?.goals).toMatchObject({
      status: 'conservado',
      coverage: 'incomplete',
    });
  });

  it('un error del proveedor al pedir las estadísticas no borra nada y no impide guardar los goles', async () => {
    const env = setup({
      100: { fixture: fixtureOk(100), statistics: [FULL_STATS, status(500)], events: FULL_EVENTS },
    });
    env.store.addMatch(M1);
    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });
    const estadisticas = JSON.parse(JSON.stringify(env.store.links.get(M1)?.statistics));

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(JSON.parse(JSON.stringify(env.store.links.get(M1)?.statistics))).toEqual(estadisticas);
    expect(report.entries[0]).toMatchObject({
      outcome: 'error',
      statistics: { status: 'error' },
      goals: { status: 'guardado' },
    });
    expect(report.exitCode).toBe(1);
  });

  it('un error del proveedor en el fixture corta el partido sin escribir', async () => {
    const env = setup({ 100: { fixture: { kind: 'timeout' } } });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(report.entries[0]?.outcome).toBe('error');
    expect(env.store.saves).toEqual([]);
  });

  it('un rechazo del plan (HTTP 200 con errors) se informa con el mensaje del proveedor', async () => {
    const rechazo: ApiFootballFetchOutcome = {
      kind: 'response',
      status: 200,
      ok: true,
      body: { errors: { plan: 'Free plans do not have access to this season.' }, response: [] },
      paging: undefined,
      headers: {},
    };
    const env = setup({
      100: { fixture: fixtureOk(100), statistics: rechazo, events: FULL_EVENTS },
    });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: true });

    expect(report.entries[0]?.reasons.join()).toContain('Free plans do not have access');
  });

  it('un 0–0 real queda como cronología completa y vacía', async () => {
    const env = setup({
      100: {
        fixture: fixtureOk(100, { goals: { home: 0, away: 0 } }),
        statistics: FULL_STATS,
        events: ok([]),
      },
    });
    env.store.addMatch(M1, { score: { home: 0, away: 0 } });

    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.store.links.get(M1)?.goals).toEqual({ coverage: 'complete', events: [] });
  });

  it('en la evidencia quedan los campos presentes y ausentes y la conciliación de goles', async () => {
    const env = setup({ 100: { ...COMPLETE, statistics: PARTIAL_STATS } });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: true });
    const evidence = report.entries[0]?.evidence;

    expect(evidence?.statisticsPresent).toContain('home.totalShots');
    expect(evidence?.statisticsAbsent).toEqual(
      expect.arrayContaining(['home.cornerKicks', 'away.fouls']),
    );
    expect(evidence?.goalsStored).toBe(3);
    expect(evidence?.goalsReconciliation).toContain('2–1');
    expect(evidence?.fixtureLeague).toEqual({ id: 4, name: 'Euro Championship', season: 2024 });
  });
});

describe('enrichMatchesBatch — cuota y límites', () => {
  it('con la cuota agotada no se consulta ni se escribe más, y el resto del lote se informa', async () => {
    const env = setup({ 100: COMPLETE, 200: { ...COMPLETE, fixture: fixtureOk(200) } }, 4);
    env.store.addMatch(M1);
    env.store.addMatch(M2);

    const report = await env.run(
      [
        { matchId: M1, fixtureId: 100 },
        { matchId: M2, fixtureId: 200 },
      ],
      { dryRun: false },
    );

    // Se hicieron 4 pedidos (el tope): 3 del primero y el fixture del segundo.
    expect(report.quota).toMatchObject({ requestsMade: 4, exhausted: true });
    expect(env.calls).toHaveLength(4);
    expect(report.entries[1]).toMatchObject({ outcome: 'error' });
    expect(report.entries[1]?.reasons.join()).toContain('cuota-agotada');
    expect(env.store.links.has(M2)).toBe(false);
    expect(report.exitCode).toBe(1);
  });

  it('un lote con la cuota ya agotada no hace ningún pedido', async () => {
    const env = setup({ 100: COMPLETE }, 1);
    // Se agota la unidad única en un pedido previo.
    await env.quota.reserveProviderQuotaUnit();
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual([]);
    expect(report.quota.requestsMade).toBe(0);
    expect(report.entries[0]?.reasons.join()).toContain('cuota-agotada');
  });

  it('si el proveedor informa que no queda cuota, se detiene aunque el ledger propio no esté al tope', async () => {
    const env = setup({
      100: {
        fixture: {
          ...(fixtureOk(100) as Extract<ApiFootballFetchOutcome, { kind: 'response' }>),
          headers: { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-limit': '100' },
        },
        statistics: FULL_STATS,
        events: FULL_EVENTS,
      },
    });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual(['fixture:100']);
    expect(report.quota).toMatchObject({
      providerRemaining: 0,
      providerLimit: 100,
      exhausted: true,
    });
  });

  it('ante un 429 espera lo que indica Retry-After y reintenta una vez; el reintento también cuenta', async () => {
    const env = setup({
      100: {
        fixture: [status(429, { 'retry-after': '7' }), fixtureOk(100)],
        statistics: FULL_STATS,
        events: FULL_EVENTS,
      },
    });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.clock.sleeps).toContain(7000);
    expect(env.calls.filter((call) => call === 'fixture:100')).toHaveLength(2);
    expect(report.quota.requestsMade).toBe(4);
    expect(env.quota.reservedCount()).toBe(4);
    expect(report.entries[0]?.outcome).toBe('enriquecido');
  });

  it('un límite de pedidos dentro de un 200 (errors.rate) también se reintenta una sola vez', async () => {
    const limitado: ApiFootballFetchOutcome = {
      kind: 'response',
      status: 200,
      ok: true,
      body: { errors: { rate: 'Too many requests.' }, response: [] },
      paging: undefined,
      headers: {},
    };
    const env = setup({
      100: { fixture: [limitado, limitado], statistics: FULL_STATS, events: FULL_EVENTS },
    });
    env.store.addMatch(M1);

    const report = await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls.filter((call) => call === 'fixture:100')).toHaveLength(2);
    expect(report.entries[0]?.outcome).toBe('error');
    expect(report.entries[0]?.reasons.join()).toContain('limitó los pedidos');
  });

  it('un error HTTP 500 no se reintenta', async () => {
    const env = setup({ 100: { fixture: status(500) } });
    env.store.addMatch(M1);

    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: false });

    expect(env.calls).toEqual(['fixture:100']);
  });

  it('respeta el límite por minuto esperando a que se libere una ventana', async () => {
    const env = setup({ 100: COMPLETE });
    env.store.addMatch(M1);

    await env.run([{ matchId: M1, fixtureId: 100 }], { dryRun: true, perMinuteLimit: 2 });

    // Con 2 por minuto, el tercer pedido tiene que esperar (≈ 60 s).
    expect(env.clock.sleeps.some((ms) => ms > 0 && ms <= 60_000)).toBe(true);
  });
});

describe('createRequestGate', () => {
  it('cuenta los pedidos realmente hechos y el contador diario', async () => {
    const q = quota(5);
    const gate = createRequestGate(
      { quota: q, clock: fakeClock() },
      { dailyQuotaLimit: 5, perMinuteLimit: 10 },
    );

    await gate.request(async () => ok([]));
    await gate.request(async () => ok([]));

    expect(gate.stats).toMatchObject({ requestsMade: 2, lastReservedCount: 2 });
  });
});

describe('formatEnrichBatchTable', () => {
  it('resume enriquecidos, sin cobertura, rechazados, errores, cuota y la cantidad de partidos', async () => {
    const env = setup({ 100: COMPLETE, 200: { fixture: ok([]) } });
    env.store.addMatch(M1);
    env.store.addMatch(M2);

    const report = await env.run(
      [
        { matchId: M1, fixtureId: 100 },
        { matchId: M2, fixtureId: 200 },
      ],
      { dryRun: true },
    );
    const table = formatEnrichBatchTable(report);

    expect(table).toContain('| Partido | Fixture | Resultado |');
    expect(table).toContain('dry_run (no se escribió nada)');
    expect(table).toContain(
      'Enriquecidos: 1 · Sin cobertura: 0 · Rechazados/ambiguos: 1 · Errores: 0',
    );
    expect(table).toContain('Cuota: 4 pedidos en esta corrida');
    expect(table).toContain('Partidos antes/después: 2/2 (sin cambios)');
  });
});
