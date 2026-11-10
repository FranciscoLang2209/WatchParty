import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IMPORT_BATCH,
  formatImportBatchTable,
  importMatchesBatch,
  parseImportBatch,
} from './import-matches-batch.js';
import type { SyncClock, SyncFootballDataOrgClient } from './sync-matches.js';
import type {
  MatchStore,
  QuotaReservationResult,
  UpsertFixtureResult,
} from '../domain/match-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type {
  FetchFootballDataOrgMatchesParams,
  FootballDataOrgFetchOutcome,
} from '../infrastructure/football-data-org-client.js';

class FakeClock implements SyncClock {
  readonly sleeps: number[] = [];
  private currentMs = Date.UTC(2026, 10, 10, 12, 0, 0);

  now(): Date {
    return new Date(this.currentMs);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.currentMs += ms;
  }
}

/** Store en memoria: upsert por (provider, externalId), lease siempre libre, cuota sin tope. */
class InMemoryStore implements MatchStore {
  readonly fixtures = new Map<string, NormalizedMatchFixture>();
  leaseTaken = false;

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

  async acquireSyncLease(): Promise<string | null> {
    return this.leaseTaken ? null : 'token';
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

  async reserveProviderQuotaUnit(): Promise<QuotaReservationResult> {
    return { reserved: true, reservedCount: 1 };
  }
}

class ScriptedClient implements SyncFootballDataOrgClient {
  readonly calls: FetchFootballDataOrgMatchesParams[] = [];

  constructor(
    private readonly respond: (
      params: FetchFootballDataOrgMatchesParams,
    ) => FootballDataOrgFetchOutcome,
  ) {}

  async fetchMatches(
    params: FetchFootballDataOrgMatchesParams,
  ): Promise<FootballDataOrgFetchOutcome> {
    this.calls.push(params);
    return this.respond(params);
  }
}

function rawMatch(id: number, competitionId: number, finished = true): unknown {
  return {
    id,
    utcDate: '2026-05-30T19:00:00Z',
    status: finished ? 'FINISHED' : 'TIMED',
    competition: { id: competitionId },
    season: { id: 2454 },
    homeTeam: { id: 1, name: 'Local' },
    awayTeam: { id: 2, name: 'Visitante' },
    score: { fullTime: finished ? { home: 2, away: 1 } : { home: null, away: null } },
  };
}

function ok(matches: unknown[]): FootballDataOrgFetchOutcome {
  return { kind: 'response', status: 200, ok: true, body: { matches }, headers: {} };
}

const RESTRICTED: FootballDataOrgFetchOutcome = {
  kind: 'response',
  status: 403,
  ok: false,
  body: { message: 'The resource you are looking for is restricted.' },
  headers: {},
};

describe('parseImportBatch', () => {
  it('el lote del piloto prioriza Champions y selecciones, con el id de cada competición', () => {
    expect(parseImportBatch(DEFAULT_IMPORT_BATCH)).toEqual([
      { competitionCode: 'CL', competitionExternalId: '2001', season: '2025' },
      { competitionCode: 'WC', competitionExternalId: '2000', season: '2026' },
      { competitionCode: 'EC', competitionExternalId: '2018', season: '2024' },
      { competitionCode: 'PL', competitionExternalId: '2021', season: '2025' },
      { competitionCode: 'PD', competitionExternalId: '2014', season: '2025' },
    ]);
  });

  it('tolera espacios y una coma final', () => {
    expect(parseImportBatch(' PPL:2025 , ELC:2024, ')).toHaveLength(2);
  });

  it.each([
    ['', /vacío/],
    ['CLI:2025', /fuera del plan/],
    ['PL-2025', /CODIGO:AÑO/],
    ['PL:25', /CODIGO:AÑO/],
    ['PL:2025,PL:2025', /repetida/],
  ])('rechaza "%s"', (raw, message) => {
    expect(() => parseImportBatch(raw)).toThrow(message);
  });
});

describe('importMatchesBatch', () => {
  it('pide cada temporada completa, sin filtro de fechas', async () => {
    const client = new ScriptedClient(() => ok([]));

    await importMatchesBatch(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      parseImportBatch('CL:2025,EC:2024'),
    );

    expect(client.calls).toEqual([
      { competitionCode: 'CL', season: '2025' },
      { competitionCode: 'EC', season: '2024' },
    ]);
  });

  it('informa por competición pedidos, devueltos, guardados y finalizados con marcador', async () => {
    const client = new ScriptedClient(() =>
      ok([rawMatch(1, 2001), rawMatch(2, 2001, false), { id: 3, status: 'AWARDED' }]),
    );

    const report = await importMatchesBatch(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      parseImportBatch('CL:2025'),
    );

    expect(report.entradas[0]).toMatchObject({
      competitionCode: 'CL',
      season: '2025',
      pedidos: 1,
      statusHttp: [200],
      devueltos: 3,
      guardados: 2,
      importados: 2,
      finalizadosConMarcador: 1,
      resultado: 'ok',
    });
    expect(report.exitCode).toBe(0);
  });

  it('registra un rechazo del plan y sigue con el resto del lote', async () => {
    const client = new ScriptedClient((params) =>
      params.competitionCode === 'WC' ? RESTRICTED : ok([rawMatch(10, 2018)]),
    );

    const report = await importMatchesBatch(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      parseImportBatch('WC:2026,EC:2024'),
    );

    expect(report.entradas[0]).toMatchObject({
      competitionCode: 'WC',
      statusHttp: [403],
      guardados: 0,
      rechazo: 'The resource you are looking for is restricted.',
      resultado: 'error',
    });
    expect(report.entradas[1]).toMatchObject({ competitionCode: 'EC', importados: 1 });
    expect(report.exitCode).toBe(1);
  });

  it('repetir el mismo lote no agrega partidos', async () => {
    const store = new InMemoryStore();
    const client = new ScriptedClient(() => ok([rawMatch(1, 2001), rawMatch(2, 2001)]));
    const deps = { client, store, clock: new FakeClock(), owner: 'o' };

    await importMatchesBatch(deps, parseImportBatch('CL:2025'));
    const second = await importMatchesBatch(deps, parseImportBatch('CL:2025'));

    expect(store.fixtures.size).toBe(2);
    expect(second.entradas[0]).toMatchObject({ importados: 0, actualizados: 2, guardados: 2 });
  });

  it('marca la entrada como lease-taken si otra corrida tiene el scope', async () => {
    const store = new InMemoryStore();
    store.leaseTaken = true;
    const client = new ScriptedClient(() => ok([]));

    const report = await importMatchesBatch(
      { client, store, clock: new FakeClock(), owner: 'o' },
      parseImportBatch('PL:2025'),
    );

    expect(client.calls).toHaveLength(0);
    expect(report.entradas[0]?.resultado).toBe('lease-taken');
    expect(report.exitCode).toBe(1);
  });

  it('respeta el límite por minuto a lo largo de todo el lote', async () => {
    const clock = new FakeClock();
    const client = new ScriptedClient(() => ok([]));
    const batch =
      'PL:2025,PD:2025,CL:2025,WC:2026,EC:2024,ELC:2025,PPL:2025,BL1:2025,SA:2025,FL1:2025,DED:2025';

    await importMatchesBatch(
      { client, store: new InMemoryStore(), clock, owner: 'o' },
      parseImportBatch(batch),
    );

    expect(client.calls).toHaveLength(11);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it('arma una tabla Markdown con una fila por entrada y el total', async () => {
    const client = new ScriptedClient(() => ok([rawMatch(1, 2001)]));
    const report = await importMatchesBatch(
      { client, store: new InMemoryStore(), clock: new FakeClock(), owner: 'o' },
      parseImportBatch('CL:2025'),
    );

    const table = formatImportBatchTable(report);

    expect(table).toContain('| CL | 2025 | 1 | 200 | 1 | 1 | 1 | 1 | ok |');
    expect(table).toContain('| **Total** |');
  });
});
