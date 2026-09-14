import { describe, it, expect, vi } from 'vitest';
import {
  syncMatches,
  type SyncMatchesClient,
  type SyncClock,
  type SyncMatchesConfig,
} from './sync-matches.js';
import type {
  MatchStore,
  SyncLeaseScope,
  SyncResultDetails,
  QuotaReservationResult,
  UpsertFixtureResult,
} from '../domain/match-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type {
  ApiFootballFetchOutcome,
  FetchFixturesPageParams,
} from '../infrastructure/api-football-client.js';

const SMALL_CONFIG: SyncMatchesConfig = {
  provider: 'api-football',
  competitionExternalId: '128',
  season: 2023,
  from: '2023-03-01',
  to: '2023-03-14',
  dailyQuotaLimit: 5,
  perMinuteLimit: 2,
};

const SCOPE: SyncLeaseScope = {
  provider: SMALL_CONFIG.provider,
  competitionExternalId: SMALL_CONFIG.competitionExternalId,
  season: String(SMALL_CONFIG.season),
};

const QUOTA_DATE_UTC = '2026-09-12';
const FIXED_NOW_MS = Date.UTC(2026, 8, 12, 10, 0, 0);

class FakeClock implements SyncClock {
  private currentMs: number;
  readonly sleeps: number[] = [];

  constructor(startMs: number = FIXED_NOW_MS) {
    this.currentMs = startMs;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.currentMs += ms;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

class FakeClient implements SyncMatchesClient {
  readonly calls: FetchFixturesPageParams[] = [];

  constructor(private readonly responses: ApiFootballFetchOutcome[]) {}

  async fetchFixturesPage(params: FetchFixturesPageParams): Promise<ApiFootballFetchOutcome> {
    this.calls.push(params);
    const next = this.responses.shift();
    if (!next) {
      throw new Error('FakeClient: no hay más respuestas programadas para este test.');
    }
    return next;
  }
}

interface FakeLeaseState {
  owner: string | null;
  token: string | null;
  expiresAtMs: number | null;
}

// Replica la semántica de las 4 funciones SQL de WAT-103 en memoria: un solo
// slot de lease (alcanza para estos tests, todos usan el mismo scope) y un
// ledger de cuota por (provider, fecha). No implementa list()/findById():
// syncMatches nunca los llama.
class FakeMatchStore implements MatchStore {
  private readonly fixturesByKey = new Map<
    string,
    { id: string; fixture: NormalizedMatchFixture }
  >();
  private nextMatchId = 1;
  private lease: FakeLeaseState = { owner: null, token: null, expiresAtMs: null };
  private nextLeaseTokenId = 1;
  private readonly quotaLedger = new Map<string, number>();

  constructor(private readonly clock: { now(): Date }) {}

  async list(): Promise<never> {
    throw new Error('FakeMatchStore.list no se usa en estos tests.');
  }

  async findById(): Promise<never> {
    throw new Error('FakeMatchStore.findById no se usa en estos tests.');
  }

  async upsertFixture(fixture: NormalizedMatchFixture): Promise<UpsertFixtureResult> {
    const key = `${fixture.provider}|${fixture.externalId}`;
    const existing = this.fixturesByKey.get(key);
    if (existing) {
      existing.fixture = fixture;
      return { id: existing.id, wasInserted: false };
    }
    const id = `match-${this.nextMatchId++}`;
    this.fixturesByKey.set(key, { id, fixture });
    return { id, wasInserted: true };
  }

  async acquireSyncLease(
    _scope: SyncLeaseScope,
    owner: string,
    leaseDurationSeconds = 900,
  ): Promise<string | null> {
    if (this.lease.token !== null) {
      return null;
    }
    const token = `lease-${this.nextLeaseTokenId++}`;
    this.lease = {
      owner,
      token,
      expiresAtMs: this.clock.now().getTime() + leaseDurationSeconds * 1000,
    };
    return token;
  }

  async reclaimExpiredSyncLease(_scope: SyncLeaseScope): Promise<boolean> {
    void _scope;
    const now = this.clock.now().getTime();
    if (
      this.lease.token !== null &&
      this.lease.expiresAtMs !== null &&
      this.lease.expiresAtMs < now
    ) {
      this.lease = { owner: null, token: null, expiresAtMs: null };
      return true;
    }
    return false;
  }

  async releaseSyncLease(_scope: SyncLeaseScope, leaseToken: string): Promise<boolean> {
    const now = this.clock.now().getTime();
    if (
      this.lease.token === leaseToken &&
      this.lease.expiresAtMs !== null &&
      this.lease.expiresAtMs > now
    ) {
      this.lease = { owner: null, token: null, expiresAtMs: null };
      return true;
    }
    return false;
  }

  async recordSyncResult(
    _scope: SyncLeaseScope,
    leaseToken: string,
    _success: boolean,
    _details?: SyncResultDetails,
  ): Promise<boolean> {
    void _success;
    void _details;
    const now = this.clock.now().getTime();
    if (
      this.lease.token === leaseToken &&
      this.lease.expiresAtMs !== null &&
      this.lease.expiresAtMs > now
    ) {
      this.lease = { owner: null, token: null, expiresAtMs: null };
      return true;
    }
    return false;
  }

  async reserveProviderQuotaUnit(
    provider: string,
    quotaDateUtc: string,
    dailyLimit: number,
  ): Promise<QuotaReservationResult> {
    const key = `${provider}|${quotaDateUtc}`;
    const current = this.quotaLedger.get(key) ?? 0;
    if (current >= dailyLimit) {
      return { reserved: false, reservedCount: current };
    }
    const next = current + 1;
    this.quotaLedger.set(key, next);
    return { reserved: true, reservedCount: next };
  }
}

function buildFixtureRaw(id: number, overrides: Record<string, unknown> = {}) {
  return {
    fixture: { id, date: '2023-03-03T23:00:00Z', status: { short: 'FT' } },
    league: { id: 128, name: 'Liga Profesional Argentina', season: 2023 },
    teams: {
      home: { id: 441, name: 'Union Santa Fe' },
      away: { id: 450, name: 'Estudiantes L.P.' },
    },
    ...overrides,
  };
}

function successOutcome(
  fixtures: unknown[],
  paging: { current: number; total: number } = { current: 1, total: 1 },
  headers: Record<string, string> = {},
): ApiFootballFetchOutcome {
  return {
    kind: 'response',
    status: 200,
    ok: true,
    body: { errors: [], results: fixtures.length, paging, response: fixtures },
    paging,
    headers,
  };
}

function httpErrorOutcome(
  status: number,
  headers: Record<string, string> = {},
): ApiFootballFetchOutcome {
  return { kind: 'response', status, ok: false, body: undefined, paging: undefined, headers };
}

describe('syncMatches', () => {
  it('reserva una unidad de cuota diaria UTC antes de la primera llamada', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const reserveSpy = vi.spyOn(store, 'reserveProviderQuotaUnit');
    const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

    await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(reserveSpy).toHaveBeenCalledWith(
      'api-football',
      QUOTA_DATE_UTC,
      SMALL_CONFIG.dailyQuotaLimit,
    );
  });

  it('si el presupuesto diario ya está agotado, no realiza ninguna llamada externa', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    for (let i = 0; i < SMALL_CONFIG.dailyQuotaLimit; i += 1) {
      await store.reserveProviderQuotaUnit(
        SMALL_CONFIG.provider,
        QUOTA_DATE_UTC,
        SMALL_CONFIG.dailyQuotaLimit,
      );
    }
    const client = new FakeClient([]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(client.calls).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    if (result.exitCode === 2) throw new Error('unreachable');
    expect(result.summary.consultasRealizadas).toBe(0);
    expect(result.summary.presupuestoRestante).toBe(0);
  });

  it('respeta el límite por minuto esperando antes de la siguiente llamada', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([
      successOutcome([buildFixtureRaw(1)], { current: 1, total: 2 }),
      successOutcome([buildFixtureRaw(2)], { current: 2, total: 2 }),
    ]);
    const config: SyncMatchesConfig = { ...SMALL_CONFIG, perMinuteLimit: 1 };

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, config);

    expect(client.calls).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    expect(clock.sleeps.some((ms) => ms >= 59_000)).toBe(true);
  });

  it('rechaza una segunda ejecución mientras el lease sigue vigente', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    await store.acquireSyncLease(SCOPE, 'owner-en-curso');
    const client = new FakeClient([]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-2' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  it('recupera un lease vencido y continúa la sincronización', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    await store.acquireSyncLease(SCOPE, 'worker-caido', 60);
    clock.advance(61_000);
    const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-nuevo' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(0);
    expect(client.calls).toHaveLength(1);
  });

  it('libera el lease al finalizar, incluso con un error de página', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);

    const first = await syncMatches(
      {
        client: new FakeClient([{ kind: 'network-error', message: 'boom' }]),
        store,
        clock,
        owner: 'owner-1',
      },
      SMALL_CONFIG,
    );
    expect(first.exitCode).toBe(1);

    const second = await syncMatches(
      {
        client: new FakeClient([successOutcome([buildFixtureRaw(1)])]),
        store,
        clock,
        owner: 'owner-2',
      },
      SMALL_CONFIG,
    );
    expect(second.exitCode).toBe(0);
  });

  it('reintenta una vez ante un timeout y continúa si el reintento funciona', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([{ kind: 'timeout' }, successOutcome([buildFixtureRaw(1)])]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(client.calls).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) throw new Error('unreachable');
    expect(result.summary.consultasReservadas).toBe(2);
    expect(result.summary.consultasRealizadas).toBe(2);
    expect(result.summary.importados).toBe(1);
  });

  it('usa Retry-After cuando está presente y es válido', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([
      httpErrorOutcome(429, { 'retry-after': '2' }),
      successOutcome([buildFixtureRaw(1)]),
    ]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(0);
    expect(clock.sleeps).toContain(2000);
  });

  it('aplica un backoff acotado cuando no hay Retry-After válido', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([httpErrorOutcome(429), successOutcome([buildFixtureRaw(1)])]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(0);
    expect(clock.sleeps).toContain(1000);
  });

  it('no reintenta más de una vez por solicitud', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([{ kind: 'timeout' }, { kind: 'timeout' }]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(client.calls).toHaveLength(2);
    expect(result.exitCode).toBe(1);
    if (result.exitCode !== 1) throw new Error('unreachable');
    expect(result.summary.errores).toEqual([{ reason: 'timeout', count: 1 }]);
  });

  it('una página fallida tras el reintento permitido finaliza como parcial sin seguir a la siguiente', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([
      successOutcome([buildFixtureRaw(1)], { current: 1, total: 2 }),
      httpErrorOutcome(500),
    ]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(1);
    if (result.exitCode !== 1) throw new Error('unreachable');
    expect(result.summary.importados).toBe(1);
    expect(result.summary.errores).toEqual([{ reason: 'http-error', count: 1 }]);
    expect(client.calls).toHaveLength(2);
  });

  it('detiene la corrida sin nueva llamada si el proveedor informa cuota diaria agotada', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeClient([
      successOutcome(
        [buildFixtureRaw(1)],
        { current: 1, total: 2 },
        { 'x-ratelimit-requests-remaining': '0' },
      ),
    ]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(1);
    expect(client.calls).toHaveLength(1);
  });

  it('un error de persistencia detiene la corrida y queda registrado', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    vi.spyOn(store, 'upsertFixture').mockRejectedValueOnce(new Error('conexión perdida'));
    const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(1);
    if (result.exitCode !== 1) throw new Error('unreachable');
    expect(result.summary.errores).toEqual([{ reason: 'persistence-error', count: 1 }]);
  });

  it('un segundo sync del mismo fixture lo actualiza y conserva su UUID interno', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const upsertSpy = vi.spyOn(store, 'upsertFixture');
    const rawFixture = buildFixtureRaw(971418);

    const firstRun = await syncMatches(
      { client: new FakeClient([successOutcome([rawFixture])]), store, clock, owner: 'owner-1' },
      SMALL_CONFIG,
    );
    const secondRun = await syncMatches(
      { client: new FakeClient([successOutcome([rawFixture])]), store, clock, owner: 'owner-2' },
      SMALL_CONFIG,
    );

    expect(firstRun.exitCode).toBe(0);
    expect(secondRun.exitCode).toBe(0);
    if (firstRun.exitCode !== 0 || secondRun.exitCode !== 0) throw new Error('unreachable');
    expect(firstRun.summary.importados).toBe(1);
    expect(secondRun.summary.actualizados).toBe(1);

    const firstResult = await upsertSpy.mock.results[0]!.value;
    const secondResult = await upsertSpy.mock.results[1]!.value;
    expect(secondResult.id).toBe(firstResult.id);
  });

  it('arma un resumen correcto con importados, omitidos y presupuesto restante', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const validFixture = buildFixtureRaw(1);
    const invalidFixture = buildFixtureRaw(2, {
      fixture: { id: 2, date: '2023-03-03T23:00:00Z', status: { short: 'SUSP' } },
    });
    const client = new FakeClient([successOutcome([validFixture, invalidFixture])]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result).toMatchObject({
      exitCode: 0,
      summary: {
        importados: 1,
        actualizados: 0,
        omitidos: [{ reason: 'unrepresentable-status', count: 1 }],
        errores: [],
        consultasRealizadas: 1,
        consultasReservadas: 1,
        presupuestoRestante: SMALL_CONFIG.dailyQuotaLimit - 1,
      },
    });
  });
});
