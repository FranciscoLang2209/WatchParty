import { describe, it, expect } from 'vitest';
import {
  syncFootballDataOrgCompetitions,
  type SyncClock,
  type SyncFootballDataOrgClient,
} from './sync-matches.js';
import {
  DAILY_FOOTBALL_DATA_ORG_COMPETITIONS,
  FOOTBALL_DATA_ORG_FREE_COMPETITIONS,
  type FootballDataOrgCompetitionSeason,
} from './football-data-org-competitions.js';
import { DEFAULT_IMPORT_BATCH, parseImportBatch } from './import-matches-batch.js';
import type {
  MatchStore,
  QuotaReservationResult,
  SyncLeaseScope,
  UpsertFixtureResult,
} from '../domain/match-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type {
  FetchFootballDataOrgMatchesParams,
  FootballDataOrgFetchOutcome,
} from '../infrastructure/football-data-org-client.js';

// 2026-11-10 10:00 UTC: la ventana móvil va del 09-11 al 24-11 (inclusivo), en dos tramos:
// 09-11 → 18-11 y 19-11 → 24-11.
const NOW_MS = Date.UTC(2026, 10, 10, 10, 0, 0);

class FakeClock implements SyncClock {
  readonly sleeps: number[] = [];
  private currentMs = NOW_MS;

  now(): Date {
    return new Date(this.currentMs);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.currentMs += ms;
  }
}

/** Store en memoria con un lease por scope y una cuota diaria compartida por proveedor. */
class InMemoryStore implements MatchStore {
  readonly fixtures = new Map<string, NormalizedMatchFixture>();
  readonly takenScopes = new Set<string>();
  quotaUsed = 0;

  constructor(private readonly quotaLimitOverride?: number) {}

  async list(): Promise<never> {
    throw new Error('no se usa');
  }

  async findById(): Promise<never> {
    throw new Error('no se usa');
  }

  async upsertFixture(fixture: NormalizedMatchFixture): Promise<UpsertFixtureResult> {
    const key = `${fixture.provider}|${fixture.externalId}`;
    const wasInserted = !this.fixtures.has(key);
    this.fixtures.set(key, fixture);
    return { id: key, wasInserted };
  }

  async acquireSyncLease(scope: SyncLeaseScope): Promise<string | null> {
    const key = `${scope.competitionExternalId}:${scope.season}`;
    return this.takenScopes.has(key) ? null : `token-${key}`;
  }

  async reclaimExpiredSyncLease(): Promise<boolean> {
    return false;
  }

  async releaseSyncLease(): Promise<boolean> {
    return true;
  }

  async recordSyncResult(): Promise<boolean> {
    return true;
  }

  async reserveProviderQuotaUnit(
    _provider: string,
    _date: string,
    dailyLimit: number,
  ): Promise<QuotaReservationResult> {
    const limit = this.quotaLimitOverride ?? dailyLimit;
    if (this.quotaUsed >= limit) return { reserved: false, reservedCount: this.quotaUsed };
    this.quotaUsed += 1;
    return { reserved: true, reservedCount: this.quotaUsed };
  }
}

class ScriptedClient implements SyncFootballDataOrgClient {
  readonly calls: FetchFootballDataOrgMatchesParams[] = [];

  constructor(
    private readonly respond: (
      params: FetchFootballDataOrgMatchesParams,
      callIndex: number,
    ) => FootballDataOrgFetchOutcome,
  ) {}

  async fetchMatches(
    params: FetchFootballDataOrgMatchesParams,
  ): Promise<FootballDataOrgFetchOutcome> {
    this.calls.push(params);
    return this.respond(params, this.calls.length - 1);
  }
}

function rawMatch(id: number, competitionId: number): unknown {
  return {
    id,
    utcDate: '2026-11-14T15:00:00Z',
    status: 'TIMED',
    competition: { id: competitionId },
    season: { id: 2500 },
    homeTeam: { id: 1, name: 'Local' },
    awayTeam: { id: 2, name: 'Visitante' },
  };
}

function ok(matches: unknown[] = []): FootballDataOrgFetchOutcome {
  return { kind: 'response', status: 200, ok: true, body: { matches }, headers: {} };
}

function httpError(status: number): FootballDataOrgFetchOutcome {
  return { kind: 'response', status, ok: false, body: undefined, headers: {} };
}

function competition(code: string): FootballDataOrgCompetitionSeason {
  return {
    competitionCode: code,
    competitionExternalId: FOOTBALL_DATA_ORG_FREE_COMPETITIONS[code]!,
    season: '2026',
  };
}

describe('DAILY_FOOTBALL_DATA_ORG_COMPETITIONS', () => {
  it('mantiene PL:2026 y suma CL, PD y SA en su temporada vigente', () => {
    expect(DAILY_FOOTBALL_DATA_ORG_COMPETITIONS).toEqual([
      { competitionCode: 'PL', competitionExternalId: '2021', season: '2026' },
      { competitionCode: 'CL', competitionExternalId: '2001', season: '2026' },
      { competitionCode: 'PD', competitionExternalId: '2014', season: '2026' },
      { competitionCode: 'SA', competitionExternalId: '2019', season: '2026' },
    ]);
  });

  it('no incluye ninguna temporada cerrada del histórico manual', () => {
    const daily = new Set(
      DAILY_FOOTBALL_DATA_ORG_COMPETITIONS.map((c) => `${c.competitionCode}:${c.season}`),
    );
    const historical = parseImportBatch(DEFAULT_IMPORT_BATCH).map(
      (c) => `${c.competitionCode}:${c.season}`,
    );

    for (const entry of historical) {
      expect(daily.has(entry)).toBe(false);
    }
  });
});

describe('syncFootballDataOrgCompetitions', () => {
  it('una corrida programada consulta todas las competiciones habilitadas con la ventana móvil', async () => {
    const client = new ScriptedClient(() => ok());

    const result = await syncFootballDataOrgCompetitions(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      DAILY_FOOTBALL_DATA_ORG_COMPETITIONS,
    );

    // Cada competición pide sus dos tramos, uno detrás del otro: 8 pedidos en total.
    expect(client.calls).toEqual(
      ['PL', 'CL', 'PD', 'SA'].flatMap((competitionCode) => [
        { competitionCode, season: '2026', dateFrom: '2026-11-09', dateTo: '2026-11-18' },
        { competitionCode, season: '2026', dateFrom: '2026-11-19', dateTo: '2026-11-24' },
      ]),
    );
    expect(result.exitCode).toBe(0);
  });

  it('con backfillFrom adelanta el inicio de la ventana en todas las competiciones', async () => {
    const client = new ScriptedClient(() => ok());

    await syncFootballDataOrgCompetitions(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      [competition('PL'), competition('CL')],
      { backfillFrom: '2026-10-01' },
    );

    // 2026-10-01 → 2026-11-24 son 55 días: seis tramos por competición, sin huecos ni solapes.
    const tramos = [
      ['2026-10-01', '2026-10-10'],
      ['2026-10-11', '2026-10-20'],
      ['2026-10-21', '2026-10-30'],
      ['2026-10-31', '2026-11-09'],
      ['2026-11-10', '2026-11-19'],
      ['2026-11-20', '2026-11-24'],
    ];
    expect(client.calls.map((c) => [c.dateFrom, c.dateTo])).toEqual([...tramos, ...tramos]);
    expect(client.calls.map((c) => c.competitionCode)).toEqual([
      ...tramos.map(() => 'PL'),
      ...tramos.map(() => 'CL'),
    ]);
  });

  it('si falla una competición sigue con las demás y reporta el fallo al final', async () => {
    const client = new ScriptedClient((params) =>
      params.competitionCode === 'CL' ? httpError(403) : ok([rawMatch(10, 2014)]),
    );

    const result = await syncFootballDataOrgCompetitions(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      [competition('CL'), competition('PD')],
    );

    // CL falla en su primer tramo y no pide el segundo; PD pide sus dos tramos.
    expect(client.calls.map((c) => c.competitionCode)).toEqual(['CL', 'PD', 'PD']);
    expect(result.competiciones.map((c) => [c.competitionCode, c.resultado])).toEqual([
      ['CL', 'error'],
      ['PD', 'ok'],
    ]);
    expect(result.total.importados).toBe(1);
    expect(result.total.errores).toEqual([{ reason: 'http-error', count: 1 }]);
    expect(result.exitCode).toBe(1);
  });

  it('comparte el límite por minuto entre competiciones, reintentos incluidos', async () => {
    const clock = new FakeClock();
    // Cada pedido responde 429 y, al reintentar, 200: 4 pedidos por competición (2 tramos con
    // su reintento), 24 para 6 competiciones.
    const client = new ScriptedClient((_params, index) =>
      index % 2 === 0 ? httpError(429) : ok(),
    );
    const codes = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];

    const result = await syncFootballDataOrgCompetitions(
      { client, store: new InMemoryStore(), clock, owner: 'o' },
      codes.map(competition),
    );

    expect(client.calls).toHaveLength(24);
    expect(result.exitCode).toBe(0);
    // Los reintentos esperan 1 s cada uno; el 11.º y el 21.º pedido tienen que esperar a que se
    // libere la ventana de un minuto abierta por el primero de cada diez.
    const throttleWaits = clock.sleeps.filter((ms) => ms > 1_000);
    expect(throttleWaits).toHaveLength(2);
    for (const wait of throttleWaits) expect(wait).toBeGreaterThan(50_000);
  });

  it('usa la cuota diaria persistente: al agotarse, las competiciones restantes no consultan', async () => {
    const client = new ScriptedClient(() => ok());

    const result = await syncFootballDataOrgCompetitions(
      { client, store: new InMemoryStore(2), clock: new FakeClock(), owner: 'o' },
      DAILY_FOOTBALL_DATA_ORG_COMPETITIONS,
    );

    // La cuota (2) se la lleva PL con sus dos tramos: las demás no consultan.
    expect(client.calls.map((c) => c.competitionCode)).toEqual(['PL', 'PL']);
    expect(result.competiciones.map((c) => c.resultado)).toEqual(['ok', 'error', 'error', 'error']);
    expect(result.exitCode).toBe(1);
  });

  it('una competición con el lease tomado no corta la corrida', async () => {
    const store = new InMemoryStore();
    store.takenScopes.add('2021:2026');
    const client = new ScriptedClient(() => ok());

    const result = await syncFootballDataOrgCompetitions(
      { client, store, clock: new FakeClock(), owner: 'o' },
      [competition('PL'), competition('CL')],
    );

    // PL no consulta (lease tomado); CL pide sus dos tramos.
    expect(client.calls.map((c) => c.competitionCode)).toEqual(['CL', 'CL']);
    expect(result.competiciones[0]?.resultado).toBe('lease-taken');
    expect(result.exitCode).toBe(1);
  });

  it('sale con 2 si todas las competiciones tienen el lease tomado', async () => {
    const store = new InMemoryStore();
    store.takenScopes.add('2021:2026');
    store.takenScopes.add('2001:2026');

    const result = await syncFootballDataOrgCompetitions(
      { client: new ScriptedClient(() => ok()), store, clock: new FakeClock(), owner: 'o' },
      [competition('PL'), competition('CL')],
    );

    expect(result.exitCode).toBe(2);
  });
});
