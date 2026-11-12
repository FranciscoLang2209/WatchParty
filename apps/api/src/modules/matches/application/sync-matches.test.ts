import { describe, it, expect, vi } from 'vitest';
import {
  syncMatches,
  syncFootballDataOrgMatches,
  importFootballDataOrgSeason,
  toFootballDataOrgDateRange,
  toFootballDataOrgDateRanges,
  FOOTBALL_DATA_ORG_MAX_RANGE_DAYS,
  type SyncMatchesClient,
  type SyncFootballDataOrgClient,
  type SyncFootballDataOrgConfig,
  type SyncClock,
  type SyncMatchesConfig,
} from './sync-matches.js';
import { agendaWindow, backfillWindow } from '../domain/match-window.js';
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
import type {
  FetchFootballDataOrgMatchesParams,
  FootballDataOrgFetchOutcome,
} from '../infrastructure/football-data-org-client.js';

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

  /** Filas guardadas, para comprobar que reimportar no duplica nada. */
  get storedFixtures(): { id: string; fixture: NormalizedMatchFixture }[] {
    return [...this.fixturesByKey.values()];
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
// ---------------------------------------------------------------------------
// football-data.org (WAT-182): mismo motor, otra fuente.
// ---------------------------------------------------------------------------

const FOOTBALL_CONFIG: SyncFootballDataOrgConfig = {
  provider: 'football-data-org',
  competitionCode: 'PL',
  competitionExternalId: '2021',
  season: '2026',
  dailyQuotaLimit: 5,
  perMinuteLimit: 2,
};

const FOOTBALL_SCOPE: SyncLeaseScope = {
  provider: FOOTBALL_CONFIG.provider,
  competitionExternalId: FOOTBALL_CONFIG.competitionExternalId,
  season: FOOTBALL_CONFIG.season,
};

class FakeFootballDataOrgClient implements SyncFootballDataOrgClient {
  readonly calls: FetchFootballDataOrgMatchesParams[] = [];

  constructor(private readonly responses: FootballDataOrgFetchOutcome[]) {}

  async fetchMatches(
    params: FetchFootballDataOrgMatchesParams,
  ): Promise<FootballDataOrgFetchOutcome> {
    this.calls.push(params);
    // El sync diario pide la ventana en tramos de hasta 10 días: los tramos que la prueba no
    // guionó explícitamente devuelven una respuesta válida y vacía. Lo que importa de cada
    // prueba se afirma sobre `calls` o sobre el resumen.
    const next = this.responses.shift();
    return next ?? footballSuccess([]);
  }
}

function buildMatchRaw(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    utcDate: '2026-09-13T14:00:00Z',
    status: 'TIMED',
    competition: { id: 2021 },
    season: { id: 2502 },
    homeTeam: { id: 57, name: 'Arsenal FC' },
    awayTeam: { id: 341, name: 'Leeds United FC' },
    ...overrides,
  };
}

function footballSuccess(matches: unknown[]): FootballDataOrgFetchOutcome {
  return { kind: 'response', status: 200, ok: true, body: { matches }, headers: {} };
}

function footballHttpError(status: number): FootballDataOrgFetchOutcome {
  return { kind: 'response', status, ok: false, body: undefined, headers: {} };
}

describe('toFootballDataOrgDateRange', () => {
  const window = agendaWindow(new Date(Date.UTC(2026, 8, 12, 10, 0, 0)));

  it('el filtro inclusivo termina un día antes del fin exclusivo de la ventana', () => {
    expect(toFootballDataOrgDateRange(window)).toEqual({
      dateFrom: '2026-09-11',
      dateTo: '2026-09-26',
    });
  });

  it('el día catorce entra en el filtro inclusivo y el quince no', () => {
    const { dateFrom, dateTo } = toFootballDataOrgDateRange(window);

    // Comparar fechas ISO como texto equivale a compararlas como fechas.
    expect('2026-09-26' >= dateFrom && '2026-09-26' <= dateTo).toBe(true);
    expect('2026-09-27' >= dateFrom && '2026-09-27' <= dateTo).toBe(false);
  });
});

describe('toFootballDataOrgDateRanges: tramos de hasta 10 días', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Todos los días (YYYY-MM-DD) que cubre una lista de tramos inclusivos, en orden. */
  function daysOf(ranges: { dateFrom: string; dateTo: string }[]): string[] {
    return ranges.flatMap(({ dateFrom, dateTo }) => {
      const days: string[] = [];
      for (
        let t = Date.parse(`${dateFrom}T00:00:00.000Z`);
        t <= Date.parse(`${dateTo}T00:00:00.000Z`);
        t += DAY
      ) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      return days;
    });
  }

  function windowOfDays(firstDay: string, days: number) {
    const from = Date.parse(`${firstDay}T00:00:00.000Z`);
    return { from: new Date(from).toISOString(), to: new Date(from + days * DAY).toISOString() };
  }

  it('el máximo por tramo es de 10 días', () => {
    expect(FOOTBALL_DATA_ORG_MAX_RANGE_DAYS).toBe(10);
  });

  it('la ventana de 14 días desde 2026-11-12 son dos tramos: ayer → +9 y +10 → hoy+14', () => {
    const window = agendaWindow(new Date(Date.UTC(2026, 10, 12, 10)));

    expect(toFootballDataOrgDateRanges(window)).toEqual([
      { dateFrom: '2026-11-11', dateTo: '2026-11-20' },
      { dateFrom: '2026-11-21', dateTo: '2026-11-26' },
    ]);
    // El primer día es ayer y el último es hoy + 14.
    expect(toFootballDataOrgDateRange(window)).toEqual({
      dateFrom: '2026-11-11',
      dateTo: '2026-11-26',
    });
  });

  it('una ventana de exactamente 10 días es un solo tramo', () => {
    expect(toFootballDataOrgDateRanges(windowOfDays('2026-11-01', 10))).toEqual([
      { dateFrom: '2026-11-01', dateTo: '2026-11-10' },
    ]);
  });

  it('una de 11 días son dos tramos, el segundo de un solo día', () => {
    expect(toFootballDataOrgDateRanges(windowOfDays('2026-11-01', 11))).toEqual([
      { dateFrom: '2026-11-01', dateTo: '2026-11-10' },
      { dateFrom: '2026-11-11', dateTo: '2026-11-11' },
    ]);
  });

  it('una de un solo día es un tramo de un día', () => {
    expect(toFootballDataOrgDateRanges(windowOfDays('2026-11-01', 1))).toEqual([
      { dateFrom: '2026-11-01', dateTo: '2026-11-01' },
    ]);
  });

  it.each(Array.from({ length: 45 }, (_, i) => i + 1))(
    'una ventana de %i días: cada día se pide exactamente una vez, en orden y sin tramos de más de 10',
    (days) => {
      const window = windowOfDays('2026-12-20', days);
      const ranges = toFootballDataOrgDateRanges(window);
      const expected = daysOf([toFootballDataOrgDateRange(window)]);

      // Sin solapamientos ni huecos (cruza el cambio de año).
      expect(daysOf(ranges)).toEqual(expected);
      expect(ranges).toHaveLength(Math.ceil(days / 10));
      for (const range of ranges) expect(daysOf([range]).length).toBeLessThanOrEqual(10);
    },
  );

  it('una ventana de recuperación larga (40 días) son 4 tramos', () => {
    const now = new Date(Date.UTC(2026, 10, 12, 10));
    const window = backfillWindow(now, '2026-10-18');

    expect(toFootballDataOrgDateRanges(window)).toEqual([
      { dateFrom: '2026-10-18', dateTo: '2026-10-27' },
      { dateFrom: '2026-10-28', dateTo: '2026-11-06' },
      { dateFrom: '2026-11-07', dateTo: '2026-11-16' },
      { dateFrom: '2026-11-17', dateTo: '2026-11-26' },
    ]);
  });
});

describe('syncFootballDataOrgMatches', () => {
  it('pide la competición y la temporada verificadas con la ventana móvil como filtro', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(1)])]);

    await syncFootballDataOrgMatches({ client, store, clock, owner: 'owner-1' }, FOOTBALL_CONFIG);

    // La ventana de 16 días (ayer → hoy+14) se pide en dos tramos consecutivos.
    expect(client.calls).toEqual([
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-09-11', dateTo: '2026-09-20' },
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-09-21', dateTo: '2026-09-26' },
    ]);
  });

  it('suma los partidos de los dos tramos con un pedido reservado y realizado por tramo', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 12, 10));
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      footballSuccess([buildMatchRaw(1)]),
      footballSuccess([buildMatchRaw(2), buildMatchRaw(3)]),
    ]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(client.calls.map(({ dateFrom, dateTo }) => [dateFrom, dateTo])).toEqual([
      ['2026-11-11', '2026-11-20'],
      ['2026-11-21', '2026-11-26'],
    ]);
    expect(result).toMatchObject({
      exitCode: 0,
      summary: { importados: 3, consultasRealizadas: 2, consultasReservadas: 2 },
    });
    expect(store.storedFixtures).toHaveLength(3);
  });

  it('un error en el primer tramo no pide el segundo y la competición queda en error', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 12, 10));
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      footballHttpError(500),
      footballSuccess([buildMatchRaw(2)]),
    ]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(client.calls).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    if (result.exitCode !== 1) throw new Error('unreachable');
    expect(result.summary.errores).toEqual([{ reason: 'http-error', count: 1 }]);
    expect(store.storedFixtures).toHaveLength(0);
  });

  it('un error en el segundo tramo conserva lo ya guardado del primero y informa el error', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 12, 10));
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      footballSuccess([buildMatchRaw(1)]),
      footballHttpError(500),
    ]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(client.calls).toHaveLength(2);
    expect(result.exitCode).toBe(1);
    // El upsert es idempotente: el primer tramo queda y la próxima corrida lo repite sin duplicar.
    expect(store.storedFixtures).toHaveLength(1);
  });

  it('la cuota agotada a mitad de camino corta sin pedir el tramo siguiente', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 12, 10));
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      footballSuccess([buildMatchRaw(1)]),
      footballSuccess([buildMatchRaw(2)]),
    ]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      { ...FOOTBALL_CONFIG, dailyQuotaLimit: 1 },
    );

    expect(client.calls).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    if (result.exitCode !== 1) throw new Error('unreachable');
    expect(result.summary).toMatchObject({
      importados: 1,
      consultasReservadas: 1,
      consultasRealizadas: 1,
      presupuestoRestante: 0,
    });
  });

  it('la importación de la temporada completa sigue siendo un solo pedido, sin fechas', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(1)])]);

    const result = await importFootballDataOrgSeason(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(client.calls).toEqual([{ competitionCode: 'PL', season: '2026' }]);
    expect(result).toMatchObject({ exitCode: 0, summary: { consultasRealizadas: 1 } });
  });

  it('con backfillFrom pide desde esa fecha hasta el fin de la ventana normal (WAT-274)', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([footballSuccess([])]);

    await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      { ...FOOTBALL_CONFIG, backfillFrom: '2026-08-15' },
    );

    // 2026-08-15 → 2026-09-26 son 43 días: cinco tramos de hasta 10 días, sin huecos.
    expect(client.calls).toEqual([
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-08-15', dateTo: '2026-08-24' },
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-08-25', dateTo: '2026-09-03' },
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-09-04', dateTo: '2026-09-13' },
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-09-14', dateTo: '2026-09-23' },
      { competitionCode: 'PL', season: '2026', dateFrom: '2026-09-24', dateTo: '2026-09-26' },
    ]);
  });

  it.each([
    [
      'cambio de mes',
      Date.UTC(2026, 9, 28, 10),
      ['2026-10-27', '2026-11-05'],
      ['2026-11-06', '2026-11-11'],
    ],
    [
      'cambio de año',
      Date.UTC(2026, 11, 28, 10),
      ['2026-12-27', '2027-01-05'],
      ['2027-01-06', '2027-01-11'],
    ],
    [
      'año calendario distinto al de la temporada',
      Date.UTC(2027, 1, 10, 10),
      ['2027-02-09', '2027-02-18'],
      ['2027-02-19', '2027-02-24'],
    ],
  ])(
    '%s: la ventana avanza y la temporada sigue siendo la verificada',
    async (_label, nowMs, [from1, to1], [from2, to2]) => {
      const clock = new FakeClock(nowMs);
      const store = new FakeMatchStore(clock);
      const client = new FakeFootballDataOrgClient([footballSuccess([])]);

      await syncFootballDataOrgMatches({ client, store, clock, owner: 'owner-1' }, FOOTBALL_CONFIG);

      expect(client.calls).toEqual([
        { competitionCode: 'PL', season: '2026', dateFrom: from1, dateTo: to1 },
        { competitionCode: 'PL', season: '2026', dateFrom: from2, dateTo: to2 },
      ]);
    },
  );

  it('importa los fixtures con identidad por proveedor e ID externo', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const upsertSpy = vi.spyOn(store, 'upsertFixture');
    const client = new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(560593)])]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'football-data-org',
        externalId: '560593',
        competitionExternalId: '2021',
        season: '2502',
        status: 'scheduled',
      }),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      summary: { importados: 1, actualizados: 0, consultasRealizadas: 2, consultasReservadas: 2 },
    });
  });

  it('omite un estado desconocido con motivo explícito, sin inventar un mapeo', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      footballSuccess([buildMatchRaw(1), buildMatchRaw(2, { status: 'SUSPENDED' })]),
    ]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(result).toMatchObject({
      exitCode: 0,
      summary: {
        importados: 1,
        omitidos: [{ reason: 'unrepresentable-status', count: 1 }],
        errores: [],
      },
    });
  });

  it('un HTTP no exitoso finaliza como parcial con su motivo', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([footballHttpError(500)]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(result.exitCode).toBe(1);
    if (result.exitCode !== 1) throw new Error('unreachable');
    expect(result.summary.errores).toEqual([{ reason: 'http-error', count: 1 }]);
  });

  it('reintenta una vez ante un timeout y continúa si el reintento funciona', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      { kind: 'timeout' },
      footballSuccess([buildMatchRaw(1)]),
    ]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    // Timeout y reintento del primer tramo, más el segundo tramo.
    expect(client.calls).toHaveLength(3);
    expect(result).toMatchObject({
      exitCode: 0,
      summary: { importados: 1, consultasReservadas: 3, consultasRealizadas: 3 },
    });
  });

  it('reutiliza la cuota persistente: reserva contra football-data-org y no llama si se agotó', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const reserveSpy = vi.spyOn(store, 'reserveProviderQuotaUnit');
    const okClient = new FakeFootballDataOrgClient([footballSuccess([])]);

    await syncFootballDataOrgMatches(
      { client: okClient, store, clock, owner: 'owner-1' },
      FOOTBALL_CONFIG,
    );

    expect(reserveSpy).toHaveBeenCalledWith(
      'football-data-org',
      QUOTA_DATE_UTC,
      FOOTBALL_CONFIG.dailyQuotaLimit,
    );

    for (let i = 1; i < FOOTBALL_CONFIG.dailyQuotaLimit; i += 1) {
      await store.reserveProviderQuotaUnit(
        FOOTBALL_CONFIG.provider,
        QUOTA_DATE_UTC,
        FOOTBALL_CONFIG.dailyQuotaLimit,
      );
    }
    const blockedClient = new FakeFootballDataOrgClient([]);

    const result = await syncFootballDataOrgMatches(
      { client: blockedClient, store, clock, owner: 'owner-2' },
      FOOTBALL_CONFIG,
    );

    expect(blockedClient.calls).toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  it('no consulta al proveedor si el lease sigue vigente', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    await store.acquireSyncLease(FOOTBALL_SCOPE, 'owner-en-curso');
    const client = new FakeFootballDataOrgClient([]);

    const result = await syncFootballDataOrgMatches(
      { client, store, clock, owner: 'owner-2' },
      FOOTBALL_CONFIG,
    );

    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  it('un segundo sync del mismo partido lo actualiza y conserva su UUID interno', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const upsertSpy = vi.spyOn(store, 'upsertFixture');

    const firstRun = await syncFootballDataOrgMatches(
      {
        client: new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(560593)])]),
        store,
        clock,
        owner: 'owner-1',
      },
      FOOTBALL_CONFIG,
    );
    const secondRun = await syncFootballDataOrgMatches(
      {
        client: new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(560593)])]),
        store,
        clock,
        owner: 'owner-2',
      },
      FOOTBALL_CONFIG,
    );

    expect(firstRun).toMatchObject({ exitCode: 0, summary: { importados: 1 } });
    expect(secondRun).toMatchObject({ exitCode: 0, summary: { actualizados: 1 } });

    const firstResult = await upsertSpy.mock.results[0]!.value;
    const secondResult = await upsertSpy.mock.results[1]!.value;
    expect(secondResult.id).toBe(firstResult.id);
  });

  it('conecta el resumen al contrato de OPS-01 al cerrar el intento', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const recordSpy = vi.spyOn(store, 'recordSyncResult');
    const client = new FakeFootballDataOrgClient([
      footballSuccess([buildMatchRaw(1), buildMatchRaw(2, { status: 'SUSPENDED' })]),
    ]);

    await syncFootballDataOrgMatches({ client, store, clock, owner: 'owner-1' }, FOOTBALL_CONFIG);

    expect(recordSpy).toHaveBeenCalledWith(
      FOOTBALL_SCOPE,
      expect.any(String),
      true,
      expect.objectContaining({
        summary: { imported: 1, updated: 0, skipped: 1, errors: 0, queries: 2 },
      }),
    );
  });
});

describe('syncMatches (API-Football) y el contrato de OPS-01', () => {
  it('también informa el resumen al cerrar el intento', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const recordSpy = vi.spyOn(store, 'recordSyncResult');
    const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

    await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(recordSpy).toHaveBeenCalledWith(
      SCOPE,
      expect.any(String),
      true,
      expect.objectContaining({
        summary: { imported: 1, updated: 0, skipped: 0, errors: 0, queries: 1 },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotencia, concurrencia y cuota del flujo de football-data.org (WAT-183)
// ---------------------------------------------------------------------------

function runFootball(
  store: FakeMatchStore,
  clock: FakeClock,
  client: FakeFootballDataOrgClient,
  owner: string,
  config: SyncFootballDataOrgConfig = FOOTBALL_CONFIG,
) {
  return syncFootballDataOrgMatches({ client, store, clock, owner }, config);
}

describe('syncFootballDataOrgMatches: idempotencia (WAT-183)', () => {
  it('reimportar el mismo partido lo actualiza, conserva su UUID y no agrega filas', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);

    const first = await runFootball(
      store,
      clock,
      new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(560593)])]),
      'owner-1',
    );
    const idAntes = store.storedFixtures[0]!.id;

    const second = await runFootball(
      store,
      clock,
      new FakeFootballDataOrgClient([
        footballSuccess([
          buildMatchRaw(560593, { status: 'IN_PLAY', utcDate: '2026-09-13T15:30:00Z' }),
        ]),
      ]),
      'owner-2',
    );

    expect(first).toMatchObject({ exitCode: 0, summary: { importados: 1, actualizados: 0 } });
    expect(second).toMatchObject({ exitCode: 0, summary: { importados: 0, actualizados: 1 } });
    expect(store.storedFixtures).toHaveLength(1);
    expect(store.storedFixtures[0]!.id).toBe(idAntes);
    expect(store.storedFixtures[0]!.fixture).toMatchObject({
      status: 'live',
      kickoffAt: '2026-09-13T15:30:00.000Z',
    });
  });

  it('el mismo ID externo en dos proveedores son partidos distintos y nunca se pisan', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);

    await runFootball(
      store,
      clock,
      new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(7)])]),
      'owner-1',
    );
    await syncMatches(
      {
        client: new FakeClient([successOutcome([buildFixtureRaw(7)])]),
        store,
        clock,
        owner: 'owner-2',
      },
      SMALL_CONFIG,
    );

    expect(store.storedFixtures).toHaveLength(2);
    expect(store.storedFixtures.map((row) => row.fixture.provider).sort()).toEqual([
      'api-football',
      'football-data-org',
    ]);
    expect(new Set(store.storedFixtures.map((row) => row.id)).size).toBe(2);
  });
});

describe('syncFootballDataOrgMatches: concurrencia (WAT-183)', () => {
  it('dos ejecuciones concurrentes sobre el mismo scope consultan al proveedor una sola vez (un pedido por tramo)', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const acquireSpy = vi.spyOn(store, 'acquireSyncLease');
    const reserveSpy = vi.spyOn(store, 'reserveProviderQuotaUnit');
    const recordSpy = vi.spyOn(store, 'recordSyncResult');
    const clientA = new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(1)])]);
    const clientB = new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(1)])]);

    const results = await Promise.all([
      runFootball(store, clock, clientA, 'owner-a'),
      runFootball(store, clock, clientB, 'owner-b'),
    ]);

    // Una completa y la otra sale por lease tomado.
    expect(results.map((result) => result.exitCode).sort()).toEqual([0, 2]);
    // Solo la que tomó el lease pidió, y una sola vez cada uno de los dos tramos.
    expect(clientA.calls.length + clientB.calls.length).toBe(2);

    // Solo una adquirió el lease; la otra no reservó cuota ni cerró un intento ajeno.
    const leases = await Promise.all(acquireSpy.mock.results.map((result) => result.value));
    expect(leases.filter((token) => token !== null)).toHaveLength(1);
    expect(reserveSpy).toHaveBeenCalledTimes(2);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(store.storedFixtures).toHaveLength(1);
  });

  it('libera el lease al terminar, incluso con error, y una ejecución posterior lo adquiere', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);

    const first = await runFootball(
      store,
      clock,
      new FakeFootballDataOrgClient([{ kind: 'network-error', message: 'boom' }]),
      'owner-1',
    );
    const second = await runFootball(
      store,
      clock,
      new FakeFootballDataOrgClient([footballSuccess([buildMatchRaw(1)])]),
      'owner-2',
    );

    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBe(0);
  });
});

describe('syncFootballDataOrgMatches: cuota (WAT-183)', () => {
  it('la reserva persiste entre ejecuciones y, agotada, no se hacen nuevas solicitudes', async () => {
    // Cada corrida usa 2 unidades (un pedido por tramo de la ventana): con 4, entran dos corridas.
    const config: SyncFootballDataOrgConfig = { ...FOOTBALL_CONFIG, dailyQuotaLimit: 4 };
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const clientOne = new FakeFootballDataOrgClient([footballSuccess([])]);
    const clientTwo = new FakeFootballDataOrgClient([footballSuccess([])]);
    const clientThree = new FakeFootballDataOrgClient([footballSuccess([])]);

    const first = await runFootball(store, clock, clientOne, 'owner-1', config);
    const second = await runFootball(store, clock, clientTwo, 'owner-2', config);
    const third = await runFootball(store, clock, clientThree, 'owner-3', config);

    expect([first.exitCode, second.exitCode, third.exitCode]).toEqual([0, 0, 1]);
    expect(clientOne.calls).toHaveLength(2);
    expect(clientTwo.calls).toHaveLength(2);
    expect(clientThree.calls).toHaveLength(0);

    if (third.exitCode === 2) throw new Error('unreachable');
    expect(third.summary).toMatchObject({
      consultasReservadas: 0,
      consultasRealizadas: 0,
      presupuestoRestante: 0,
    });
  });

  it('un reintento reserva su propia unidad: sin cuota para el reintento, no se vuelve a llamar', async () => {
    const config: SyncFootballDataOrgConfig = { ...FOOTBALL_CONFIG, dailyQuotaLimit: 1 };
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    const client = new FakeFootballDataOrgClient([
      { kind: 'timeout' },
      footballSuccess([buildMatchRaw(1)]),
    ]);

    const result = await runFootball(store, clock, client, 'owner-1', config);

    expect(client.calls).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    if (result.exitCode === 2) throw new Error('unreachable');
    expect(result.summary).toMatchObject({
      importados: 0,
      consultasReservadas: 1,
      consultasRealizadas: 1,
      presupuestoRestante: 0,
    });
  });

  it('agotar la cuota de API-Football no bloquea a football-data.org', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    for (let i = 0; i < SMALL_CONFIG.dailyQuotaLimit; i += 1) {
      await store.reserveProviderQuotaUnit(
        SMALL_CONFIG.provider,
        QUOTA_DATE_UTC,
        SMALL_CONFIG.dailyQuotaLimit,
      );
    }
    const client = new FakeFootballDataOrgClient([footballSuccess([])]);

    const result = await runFootball(store, clock, client, 'owner-1');

    expect(result.exitCode).toBe(0);
    expect(client.calls).toHaveLength(2);
  });

  it('agotar la cuota de football-data.org no bloquea a API-Football', async () => {
    const clock = new FakeClock();
    const store = new FakeMatchStore(clock);
    for (let i = 0; i < FOOTBALL_CONFIG.dailyQuotaLimit; i += 1) {
      await store.reserveProviderQuotaUnit(
        FOOTBALL_CONFIG.provider,
        QUOTA_DATE_UTC,
        FOOTBALL_CONFIG.dailyQuotaLimit,
      );
    }
    const client = new FakeClient([successOutcome([])]);

    const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

    expect(result.exitCode).toBe(0);
    expect(client.calls).toHaveLength(1);
  });
  describe('syncMatches: fallos no pueden parecer éxito (OPS-05)', () => {
    it('cuota agotada: registra fallo (no éxito) y sale con código 1', async () => {
      const clock = new FakeClock();
      const store = new FakeMatchStore(clock);
      for (let i = 0; i < SMALL_CONFIG.dailyQuotaLimit; i += 1) {
        await store.reserveProviderQuotaUnit(
          SMALL_CONFIG.provider,
          QUOTA_DATE_UTC,
          SMALL_CONFIG.dailyQuotaLimit,
        );
      }
      const recordSpy = vi.spyOn(store, 'recordSyncResult');
      const client = new FakeClient([]);

      const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

      expect(result.exitCode).toBe(1);
      expect(client.calls).toHaveLength(0);
      expect(recordSpy).toHaveBeenCalledWith(
        SCOPE,
        expect.any(String),
        false,
        expect.objectContaining({ error: 'quota-exhausted' }),
      );
    });

    it('falla del proveedor: registra fallo y sale con código 1', async () => {
      const clock = new FakeClock();
      const store = new FakeMatchStore(clock);
      const recordSpy = vi.spyOn(store, 'recordSyncResult');
      const client = new FakeClient([httpErrorOutcome(500)]);

      const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

      expect(result.exitCode).toBe(1);
      expect(recordSpy).toHaveBeenCalledWith(
        SCOPE,
        expect.any(String),
        false,
        expect.objectContaining({ error: 'http-error' }),
      );
    });

    it('si recordSyncResult devuelve false, no hay éxito aparente: sale con código 1', async () => {
      const clock = new FakeClock();
      const store = new FakeMatchStore(clock);
      vi.spyOn(store, 'recordSyncResult').mockResolvedValueOnce(false);
      const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

      const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

      expect(result.exitCode).toBe(1);
      if (result.exitCode !== 1) throw new Error('unreachable');
      expect(result.summary.errores).toEqual([{ reason: 'result-not-recorded', count: 1 }]);
    });

    it('si recordSyncResult lanza error, no se propaga y sale con código 1', async () => {
      const clock = new FakeClock();
      const store = new FakeMatchStore(clock);
      vi.spyOn(store, 'recordSyncResult').mockRejectedValueOnce(new Error('base caída'));
      const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

      const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

      expect(result.exitCode).toBe(1);
      if (result.exitCode !== 1) throw new Error('unreachable');
      expect(result.summary.errores).toEqual([{ reason: 'result-record-error', count: 1 }]);
    });

    it('control: una corrida sana registra éxito y sale con código 0', async () => {
      const clock = new FakeClock();
      const store = new FakeMatchStore(clock);
      const recordSpy = vi.spyOn(store, 'recordSyncResult');
      const client = new FakeClient([successOutcome([buildFixtureRaw(1)])]);

      const result = await syncMatches({ client, store, clock, owner: 'owner-1' }, SMALL_CONFIG);

      expect(result.exitCode).toBe(0);
      expect(recordSpy).toHaveBeenCalledWith(SCOPE, expect.any(String), true, expect.anything());
    });
  });
});
