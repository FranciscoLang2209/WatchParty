import type { MatchStore } from '../domain/match-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type {
  FetchFootballDataOrgMatchesParams,
  FootballDataOrgFetchOutcome,
} from '../infrastructure/football-data-org-client.js';
import { FOOTBALL_DATA_ORG_PROVIDER } from './football-data-org-normalizer.js';
import {
  DEFAULT_SYNC_FOOTBALL_DATA_ORG_CONFIG,
  importFootballDataOrgSeason,
  type ReasonCount,
  type SyncClock,
  type SyncFootballDataOrgClient,
} from './sync-matches.js';
import {
  createPerMinuteThrottledClient,
  FOOTBALL_DATA_ORG_FREE_COMPETITIONS,
  type FootballDataOrgCompetitionSeason,
} from './football-data-org-competitions.js';

/**
 * Lote del piloto para el Tercer Steering: Champions y torneos de selecciones
 * primero, por si la cuota obliga a cortar.
 */
export const DEFAULT_IMPORT_BATCH = 'CL:2025,WC:2026,EC:2024,PL:2025,PD:2025';

export type ImportBatchEntry = FootballDataOrgCompetitionSeason;

/**
 * Lee un lote `CODIGO:AÑO` separado por comas, p. ej. `CL:2025,WC:2026`.
 * Lanza ante un código fuera del plan, un año inválido o una entrada repetida.
 */
export function parseImportBatch(raw: string): ImportBatchEntry[] {
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  if (items.length === 0) {
    throw new Error('El lote de importación está vacío.');
  }

  const seen = new Set<string>();

  return items.map((item) => {
    const match = /^([A-Z0-9]+):(\d{4})$/.exec(item);
    if (!match) {
      throw new Error(`Entrada de lote inválida: "${item}". Formato esperado: CODIGO:AÑO.`);
    }

    const competitionCode = match[1]!;
    const season = match[2]!;
    const competitionExternalId = FOOTBALL_DATA_ORG_FREE_COMPETITIONS[competitionCode];
    if (competitionExternalId === undefined) {
      throw new Error(
        `Competición fuera del plan: "${competitionCode}". Valores permitidos: ${Object.keys(
          FOOTBALL_DATA_ORG_FREE_COMPETITIONS,
        ).join(', ')}.`,
      );
    }

    if (seen.has(item)) {
      throw new Error(`Entrada de lote repetida: "${item}".`);
    }
    seen.add(item);

    return { competitionCode, competitionExternalId, season };
  });
}

export interface ImportBatchEntryReport {
  competitionCode: string;
  season: string;
  /** Pedidos HTTP hechos al proveedor (incluye el reintento, si hubo). */
  pedidos: number;
  /** Status HTTP de cada pedido; `null` si no hubo respuesta (timeout o red). */
  statusHttp: (number | null)[];
  /** Partidos que devolvió el proveedor, válidos o no. */
  devueltos: number;
  /** Partidos guardados en esta corrida (nuevos más actualizados). */
  guardados: number;
  importados: number;
  actualizados: number;
  /** Guardados con estado `finished` y marcador completo. */
  finalizadosConMarcador: number;
  omitidos: ReasonCount[];
  errores: ReasonCount[];
  /** Mensaje del proveedor cuando rechaza el pedido (p. ej. por el plan). */
  rechazo?: string;
  /** `lease-taken` si otra corrida tenía el mismo scope. */
  resultado: 'ok' | 'error' | 'lease-taken';
}

export interface ImportBatchReport {
  entradas: ImportBatchEntryReport[];
  totales: {
    pedidos: number;
    devueltos: number;
    guardados: number;
    importados: number;
    finalizadosConMarcador: number;
  };
  exitCode: 0 | 1;
}

export interface ImportBatchDeps {
  client: SyncFootballDataOrgClient;
  store: MatchStore;
  clock: SyncClock;
  owner: string;
}

interface EntryCounters {
  statusHttp: (number | null)[];
  devueltos: number;
  finalizadosConMarcador: number;
  rechazo?: string;
}

function readMatchesCount(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const matches = (body as Record<string, unknown>).matches;
  return Array.isArray(matches) ? matches.length : 0;
}

function readProviderMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as Record<string, unknown>).message;
  return typeof message === 'string' ? message : undefined;
}

/** Registra status, partidos devueltos y rechazos de cada pedido de la entrada en curso. */
function createCountingClient(
  client: SyncFootballDataOrgClient,
  getCounters: () => EntryCounters,
): SyncFootballDataOrgClient {
  return {
    async fetchMatches(params: FetchFootballDataOrgMatchesParams, signal?: AbortSignal) {
      const outcome: FootballDataOrgFetchOutcome = await client.fetchMatches(params, signal);
      const counters = getCounters();

      if (outcome.kind === 'response') {
        counters.statusHttp.push(outcome.status);
        if (outcome.ok) {
          counters.devueltos += readMatchesCount(outcome.body);
          // Un 429 seguido de un reintento exitoso no es un rechazo.
          delete counters.rechazo;
        } else {
          counters.rechazo = readProviderMessage(outcome.body) ?? `HTTP ${outcome.status}`;
        }
      } else {
        counters.statusHttp.push(null);
        counters.rechazo = outcome.kind;
      }

      return outcome;
    },
  };
}

function createCountingStore(store: MatchStore, getCounters: () => EntryCounters): MatchStore {
  return {
    list: (window) => store.list(window),
    findById: (id) => store.findById(id),
    acquireSyncLease: (scope, owner, duration) => store.acquireSyncLease(scope, owner, duration),
    reclaimExpiredSyncLease: (scope) => store.reclaimExpiredSyncLease(scope),
    releaseSyncLease: (scope, token) => store.releaseSyncLease(scope, token),
    recordSyncResult: (scope, token, success, details) =>
      store.recordSyncResult(scope, token, success, details),
    reserveProviderQuotaUnit: (provider, date, limit) =>
      store.reserveProviderQuotaUnit(provider, date, limit),
    async upsertFixture(fixture: NormalizedMatchFixture) {
      const result = await store.upsertFixture(fixture);
      if (fixture.status === 'finished' && fixture.score !== null) {
        getCounters().finalizadosConMarcador += 1;
      }
      return result;
    },
  };
}

/**
 * Importa cada competición y temporada del lote, una por vez, con el mismo
 * motor que la sincronización diaria. Un rechazo del proveedor en una entrada
 * no corta el lote: queda registrado y se sigue con la siguiente.
 */
export async function importMatchesBatch(
  deps: ImportBatchDeps,
  entries: readonly ImportBatchEntry[],
): Promise<ImportBatchReport> {
  const { dailyQuotaLimit, perMinuteLimit } = DEFAULT_SYNC_FOOTBALL_DATA_ORG_CONFIG;
  let counters: EntryCounters = { statusHttp: [], devueltos: 0, finalizadosConMarcador: 0 };
  const client = createCountingClient(
    createPerMinuteThrottledClient(deps.client, deps.clock, perMinuteLimit),
    () => counters,
  );
  const store = createCountingStore(deps.store, () => counters);

  const reports: ImportBatchEntryReport[] = [];

  for (const entry of entries) {
    counters = { statusHttp: [], devueltos: 0, finalizadosConMarcador: 0 };

    const result = await importFootballDataOrgSeason(
      { client, store, clock: deps.clock, owner: deps.owner },
      {
        provider: FOOTBALL_DATA_ORG_PROVIDER,
        competitionCode: entry.competitionCode,
        competitionExternalId: entry.competitionExternalId,
        season: entry.season,
        dailyQuotaLimit,
        perMinuteLimit,
      },
    );

    const base = {
      competitionCode: entry.competitionCode,
      season: entry.season,
      statusHttp: counters.statusHttp,
      devueltos: counters.devueltos,
      finalizadosConMarcador: counters.finalizadosConMarcador,
      ...(counters.rechazo !== undefined ? { rechazo: counters.rechazo } : {}),
    };

    if (result.exitCode === 2) {
      reports.push({
        ...base,
        pedidos: 0,
        guardados: 0,
        importados: 0,
        actualizados: 0,
        omitidos: [],
        errores: [],
        resultado: 'lease-taken',
      });
      continue;
    }

    const { summary } = result;
    reports.push({
      ...base,
      pedidos: summary.consultasRealizadas,
      guardados: summary.importados + summary.actualizados,
      importados: summary.importados,
      actualizados: summary.actualizados,
      omitidos: summary.omitidos,
      errores: summary.errores,
      resultado: result.exitCode === 0 ? 'ok' : 'error',
    });
  }

  const sum = (pick: (r: ImportBatchEntryReport) => number) =>
    reports.reduce((total, r) => total + pick(r), 0);

  return {
    entradas: reports,
    totales: {
      pedidos: sum((r) => r.pedidos),
      devueltos: sum((r) => r.devueltos),
      guardados: sum((r) => r.guardados),
      importados: sum((r) => r.importados),
      finalizadosConMarcador: sum((r) => r.finalizadosConMarcador),
    },
    exitCode: reports.every((r) => r.resultado === 'ok') ? 0 : 1,
  };
}

/** Tabla Markdown del reporte, lista para pegar como evidencia. */
export function formatImportBatchTable(report: ImportBatchReport): string {
  const header = [
    '| Competición | Temporada | Pedidos | HTTP | Devueltos | Guardados | Nuevos | Finalizados con marcador | Resultado |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = report.entradas.map((r) =>
    [
      r.competitionCode,
      r.season,
      r.pedidos,
      r.statusHttp.map((s) => s ?? 'sin respuesta').join(', ') || '—',
      r.devueltos,
      r.guardados,
      r.importados,
      r.finalizadosConMarcador,
      r.rechazo ? `${r.resultado}: ${r.rechazo}` : r.resultado,
    ].join(' | '),
  );
  const t = report.totales;
  const total = `| **Total** | | ${t.pedidos} | | ${t.devueltos} | ${t.guardados} | ${t.importados} | ${t.finalizadosConMarcador} | |`;
  return [...header, ...rows.map((row) => `| ${row} |`), total].join('\n');
}
