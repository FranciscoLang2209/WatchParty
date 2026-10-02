import type {
  MatchStore,
  SyncAttemptSummary,
  SyncLeaseScope,
  SyncResultDetails,
} from '../domain/match-store.js';
import { agendaWindow, type MatchWindow } from '../domain/match-window.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type {
  ApiFootballFetchOutcome,
  FetchFixturesPageParams,
} from '../infrastructure/api-football-client.js';
import type {
  FetchFootballDataOrgMatchesParams,
  FootballDataOrgFetchOutcome,
} from '../infrastructure/football-data-org-client.js';
import type { NormalizedSportsFixture } from './normalized-sports-fixture.js';
import { normalizeApiFootballFixturesPage } from './api-football-normalizer.js';
import {
  FOOTBALL_DATA_ORG_PROVIDER,
  normalizeFootballDataOrgMatches,
} from './football-data-org-normalizer.js';

export interface SyncMatchesClient {
  fetchFixturesPage(
    params: FetchFixturesPageParams,
    signal?: AbortSignal,
  ): Promise<ApiFootballFetchOutcome>;
}

export interface SyncFootballDataOrgClient {
  fetchMatches(
    params: FetchFootballDataOrgMatchesParams,
    signal?: AbortSignal,
  ): Promise<FootballDataOrgFetchOutcome>;
}

export interface SyncClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** Lo que cualquier proveedor comparte: persistencia, reloj y dueño del lease. */
export interface SyncRunDeps {
  store: MatchStore;
  clock: SyncClock;
  owner: string;
}

export interface SyncMatchesDeps extends SyncRunDeps {
  client: SyncMatchesClient;
}

export interface SyncFootballDataOrgDeps extends SyncRunDeps {
  client: SyncFootballDataOrgClient;
}

export interface SyncMatchesConfig {
  provider: string;
  competitionExternalId: string;
  season: number;
  from: string;
  to: string;
  dailyQuotaLimit: number;
  perMinuteLimit: number;
}

// Parámetros aprobados por B1.1 (docs/integrations/api-football-coverage.md)
// y política de cuota fija del propio ticket B1.3. No son secretos ni
// configuración de entorno: son valores de negocio fijos, por eso viven acá
// y no en sports-provider-env.ts.
export const DEFAULT_SYNC_MATCHES_CONFIG: SyncMatchesConfig = {
  provider: 'api-football',
  competitionExternalId: '128',
  season: 2023,
  from: '2023-03-01',
  to: '2023-03-14',
  dailyQuotaLimit: 80,
  perMinuteLimit: 10,
};

export interface SyncFootballDataOrgConfig {
  provider: string;
  /** Código con el que el proveedor pide la competición, p. ej. "PL". */
  competitionCode: string;
  /** Id externo de la competición: el mismo que llevan los fixtures normalizados. */
  competitionExternalId: string;
  /**
   * Temporada verificada, tal como la entiende el proveedor (año de inicio).
   * Es un valor fijo: NO se deriva del año calendario, porque una temporada
   * 2026/27 sigue siendo la "2026" también en 2027.
   */
  season: string;
  dailyQuotaLimit: number;
  perMinuteLimit: number;
}

// Competición y temporada verificadas en WAT-180
// (docs/integrations/football-data-org-coverage.md). El presupuesto diario y
// el límite por minuto son los mismos valores internos que ya usa API-Football
// (el plan Free de football-data.org permite 10 pedidos por minuto): son un
// presupuesto propio de la app, no un número informado por el proveedor.
export const DEFAULT_SYNC_FOOTBALL_DATA_ORG_CONFIG: SyncFootballDataOrgConfig = {
  provider: FOOTBALL_DATA_ORG_PROVIDER,
  competitionCode: 'PL',
  competitionExternalId: '2021',
  season: '2026',
  dailyQuotaLimit: 80,
  perMinuteLimit: 10,
};

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface SyncMatchesSummary {
  importados: number;
  actualizados: number;
  omitidos: ReasonCount[];
  errores: ReasonCount[];
  consultasRealizadas: number;
  consultasReservadas: number;
  presupuestoRestante: number;
}

export type SyncMatchesResult = { exitCode: 2 } | { exitCode: 0 | 1; summary: SyncMatchesSummary };

/**
 * Lo mínimo que el motor lee de una respuesta del proveedor: el tipo de
 * resultado y, si hubo respuesta, su status y sus headers. Ambos clientes
 * (API-Football y football-data.org) lo cumplen.
 */
type SyncFetchOutcome =
  | { kind: 'response'; status: number; headers: Record<string, string> }
  | { kind: 'timeout' }
  | { kind: 'network-error'; message: string };

type SyncPageResult =
  | {
      kind: 'success';
      totalPages: number;
      fixtures: NormalizedMatchFixture[];
      skipped: { reason: string }[];
    }
  | { kind: 'error'; reason: string };

/**
 * Las tres cosas que cambian de un proveedor a otro. Todo lo demás (lease,
 * cuota persistente, límite por minuto, reintento, upsert) vive una sola vez
 * en `runSync`.
 */
interface SyncSource<O extends SyncFetchOutcome> {
  fetchPage(page: number): Promise<O>;
  /** Restante diario que informó el proveedor en esta respuesta, o `null` si no informó. */
  readProviderRemaining(outcome: O): number | null;
  normalizePage(outcome: O): SyncPageResult;
}

interface SyncRunConfig {
  provider: string;
  competitionExternalId: string;
  season: string;
  dailyQuotaLimit: number;
  perMinuteLimit: number;
}

const PER_MINUTE_WINDOW_MS = 60_000;

// Con un máximo de un reintento por solicitud, un backoff "exponencial" no
// tiene una secuencia sobre la que crecer: se reduce a un único delay fijo
// y acotado cuando el proveedor no indicó Retry-After.
const FALLBACK_RETRY_DELAY_MS = 1_000;

function createEmptySummary(): SyncMatchesSummary {
  return {
    importados: 0,
    actualizados: 0,
    omitidos: [],
    errores: [],
    consultasRealizadas: 0,
    consultasReservadas: 0,
    presupuestoRestante: 0,
  };
}

function incrementReasonCount(list: ReasonCount[], reason: string): void {
  const existing = list.find((entry) => entry.reason === reason);
  if (existing) {
    existing.count += 1;
  } else {
    list.push({ reason, count: 1 });
  }
}

function totalCount(list: ReasonCount[]): number {
  return list.reduce((total, entry) => total + entry.count, 0);
}

// Contrato acordado con OPS-01 (WAT-184, `SyncAttemptSummary`): contadores
// del intento, con omitidos y errores como totales de todos los motivos.
// `queries` son las consultas HTTP realmente hechas al proveedor.
function toAttemptSummary(summary: SyncMatchesSummary): SyncAttemptSummary {
  return {
    imported: summary.importados,
    updated: summary.actualizados,
    skipped: totalCount(summary.omitidos),
    errors: totalCount(summary.errores),
    queries: summary.consultasRealizadas,
  };
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isRetryableOutcome(outcome: SyncFetchOutcome): boolean {
  if (outcome.kind === 'timeout') return true;
  return outcome.kind === 'response' && outcome.status === 429;
}

function parseRetryAfterMs(value: string, now: Date): number | null {
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(asDate - now.getTime(), 0);
  }

  return null;
}

function computeRetryDelayMs(outcome: SyncFetchOutcome, now: Date): number {
  if (outcome.kind === 'response') {
    const retryAfter = outcome.headers['retry-after'];
    if (retryAfter !== undefined) {
      const parsed = parseRetryAfterMs(retryAfter, now);
      if (parsed !== null) return parsed;
    }
  }

  return FALLBACK_RETRY_DELAY_MS;
}

function toNormalizedMatchFixture(fixture: NormalizedSportsFixture): NormalizedMatchFixture {
  return {
    provider: fixture.provider,
    externalId: String(fixture.externalFixtureId),
    homeTeam: {
      externalId: String(fixture.homeTeam.externalTeamId),
      name: fixture.homeTeam.name,
    },
    awayTeam: {
      externalId: String(fixture.awayTeam.externalTeamId),
      name: fixture.awayTeam.name,
    },
    competitionExternalId: String(fixture.externalLeagueId),
    season: String(fixture.season),
    kickoffAt: fixture.kickoffAt,
    status: fixture.status,
  };
}

function createApiFootballSource(
  client: SyncMatchesClient,
  config: SyncMatchesConfig,
): SyncSource<ApiFootballFetchOutcome> {
  return {
    fetchPage: (page) =>
      client.fetchFixturesPage({
        league: Number(config.competitionExternalId),
        season: config.season,
        from: config.from,
        to: config.to,
        page,
      }),
    readProviderRemaining: (outcome) => {
      if (outcome.kind !== 'response') return null;

      const raw = outcome.headers['x-ratelimit-requests-remaining'];
      if (raw === undefined) return null;

      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    },
    normalizePage: (outcome) => {
      const normalized = normalizeApiFootballFixturesPage(outcome);

      if (normalized.kind === 'error') {
        return { kind: 'error', reason: normalized.reason };
      }

      return {
        kind: 'success',
        totalPages: normalized.paging.total,
        fixtures: normalized.fixtures.map(toNormalizedMatchFixture),
        skipped: normalized.skipped,
      };
    },
  };
}

/**
 * Convierte la ventana de la agenda (instantes UTC, fin exclusivo) al filtro
 * de football-data.org, que trabaja con días `YYYY-MM-DD` y cuyo `dateTo` es
 * INCLUSIVO (verificado contra la API real). El fin de la ventana es el
 * 00:00 UTC del día posterior al séptimo, así que el último día que hay que
 * pedir es el del instante inmediatamente anterior: pasar la fecha del fin
 * exclusivo tal cual pediría un día de más, y restarle un día de más
 * perdería el séptimo.
 */
export function toFootballDataOrgDateRange(window: MatchWindow): {
  dateFrom: string;
  dateTo: string;
} {
  return {
    dateFrom: window.from.slice(0, 10),
    dateTo: new Date(Date.parse(window.to) - 1).toISOString().slice(0, 10),
  };
}

function createFootballDataOrgSource(
  client: SyncFootballDataOrgClient,
  config: SyncFootballDataOrgConfig,
  window: MatchWindow,
): SyncSource<FootballDataOrgFetchOutcome> {
  const { dateFrom, dateTo } = toFootballDataOrgDateRange(window);

  return {
    // La API no pagina: un único pedido trae toda la ventana, así que `page`
    // no se usa.
    fetchPage: () =>
      client.fetchMatches({
        competitionCode: config.competitionCode,
        season: config.season,
        dateFrom,
        dateTo,
      }),
    // football-data.org no informa un restante diario en sus headers
    // (docs/integrations/football-data-org-coverage.md): no hay nada que
    // respetar además del ledger propio y del límite por minuto.
    readProviderRemaining: () => null,
    normalizePage: (outcome) => {
      const normalized = normalizeFootballDataOrgMatches(outcome);

      if (normalized.kind === 'error') {
        return { kind: 'error', reason: normalized.reason };
      }

      return {
        kind: 'success',
        totalPages: 1,
        fixtures: normalized.fixtures,
        skipped: normalized.skipped,
      };
    },
  };
}

interface RunState {
  requestTimestampsMs: number[];
  providerObservedRemaining: number | null;
  lastReservedCount: number;
}

type ReservationOutcome<O extends SyncFetchOutcome> =
  { kind: 'quota-exhausted' } | { kind: 'response'; outcome: O };

async function respectPerMinuteLimit(
  clock: SyncClock,
  state: RunState,
  perMinuteLimit: number,
): Promise<void> {
  for (;;) {
    const nowMs = clock.now().getTime();
    state.requestTimestampsMs = state.requestTimestampsMs.filter(
      (timestamp) => nowMs - timestamp < PER_MINUTE_WINDOW_MS,
    );

    if (state.requestTimestampsMs.length < perMinuteLimit) {
      return;
    }

    const oldest = state.requestTimestampsMs[0]!;
    await clock.sleep(PER_MINUTE_WINDOW_MS - (nowMs - oldest));
  }
}

// Antes de cada llamada (inicial o reintento): valida el remanente que ya
// informó el proveedor en esta misma corrida, respeta el límite por minuto y
// recién ahí reserva una unidad persistente del ledger diario. Si cualquiera
// de esos controles corta el paso, nunca llega a llamar a `fetchPage`.
async function reserveAndFetch<O extends SyncFetchOutcome>(
  deps: SyncRunDeps,
  config: SyncRunConfig,
  source: SyncSource<O>,
  page: number,
  state: RunState,
  summary: SyncMatchesSummary,
): Promise<ReservationOutcome<O>> {
  if (state.providerObservedRemaining !== null && state.providerObservedRemaining <= 0) {
    return { kind: 'quota-exhausted' };
  }

  await respectPerMinuteLimit(deps.clock, state, config.perMinuteLimit);

  const quotaDateUtc = toUtcDateString(deps.clock.now());
  const reservation = await deps.store.reserveProviderQuotaUnit(
    config.provider,
    quotaDateUtc,
    config.dailyQuotaLimit,
  );
  state.lastReservedCount = reservation.reservedCount;

  if (!reservation.reserved) {
    return { kind: 'quota-exhausted' };
  }
  summary.consultasReservadas += 1;

  state.requestTimestampsMs.push(deps.clock.now().getTime());
  const outcome = await source.fetchPage(page);
  summary.consultasRealizadas += 1;

  const observedRemaining = source.readProviderRemaining(outcome);
  if (observedRemaining !== null) {
    state.providerObservedRemaining = observedRemaining;
  }

  return { kind: 'response', outcome };
}

async function fetchPageWithRetryPolicy<O extends SyncFetchOutcome>(
  deps: SyncRunDeps,
  config: SyncRunConfig,
  source: SyncSource<O>,
  page: number,
  state: RunState,
  summary: SyncMatchesSummary,
): Promise<ReservationOutcome<O>> {
  let attempt = await reserveAndFetch(deps, config, source, page, state, summary);

  if (attempt.kind === 'quota-exhausted') {
    return attempt;
  }

  if (isRetryableOutcome(attempt.outcome)) {
    const delayMs = computeRetryDelayMs(attempt.outcome, deps.clock.now());
    await deps.clock.sleep(delayMs);
    attempt = await reserveAndFetch(deps, config, source, page, state, summary);
  }

  return attempt;
}

/**
 * Motor de sincronización compartido: lease, cuota persistente, límite por
 * minuto, reintento y upsert, una sola vez para cualquier proveedor. Solo
 * `source` sabe cómo pedir y normalizar una página de ese proveedor.
 */
async function runSync<O extends SyncFetchOutcome>(
  deps: SyncRunDeps,
  config: SyncRunConfig,
  source: SyncSource<O>,
): Promise<SyncMatchesResult> {
  const scope: SyncLeaseScope = {
    provider: config.provider,
    competitionExternalId: config.competitionExternalId,
    season: config.season,
  };

  let leaseToken = await deps.store.acquireSyncLease(scope, deps.owner);

  if (leaseToken === null) {
    const reclaimed = await deps.store.reclaimExpiredSyncLease(scope);
    if (reclaimed) {
      leaseToken = await deps.store.acquireSyncLease(scope, deps.owner);
    }
  }

  if (leaseToken === null) {
    return { exitCode: 2 };
  }

  const summary = createEmptySummary();
  const state: RunState = {
    requestTimestampsMs: [],
    providerObservedRemaining: null,
    lastReservedCount: 0,
  };

  let firstErrorReason: string | undefined;
  let quotaExhausted = false;

  try {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const attempt = await fetchPageWithRetryPolicy(deps, config, source, page, state, summary);

      if (attempt.kind === 'quota-exhausted') {
        quotaExhausted = true;
        break;
      }

      const normalized = source.normalizePage(attempt.outcome);

      if (normalized.kind === 'error') {
        incrementReasonCount(summary.errores, normalized.reason);
        firstErrorReason ??= normalized.reason;
        break;
      }

      totalPages = normalized.totalPages;

      for (const skipped of normalized.skipped) {
        incrementReasonCount(summary.omitidos, skipped.reason);
      }

      for (const fixture of normalized.fixtures) {
        const result = await deps.store.upsertFixture(fixture);
        if (result.wasInserted) {
          summary.importados += 1;
        } else {
          summary.actualizados += 1;
        }
      }

      page += 1;
    }
  } catch {
    incrementReasonCount(summary.errores, 'persistence-error');
    firstErrorReason ??= 'persistence-error';
  } finally {
    const details: SyncResultDetails = {
      error: firstErrorReason,
      summary: toAttemptSummary(summary),
    };
    if (state.providerObservedRemaining !== null) {
      details.observedQuotaRemaining = state.providerObservedRemaining;
    }
    await deps.store.recordSyncResult(scope, leaseToken, firstErrorReason === undefined, details);
  }

  summary.presupuestoRestante = Math.max(config.dailyQuotaLimit - state.lastReservedCount, 0);

  const exitCode: 0 | 1 = firstErrorReason !== undefined || quotaExhausted ? 1 : 0;

  return { exitCode, summary };
}

/** Sincronización con API-Football (ventana histórica aprobada por B1.1). */
export async function syncMatches(
  deps: SyncMatchesDeps,
  config: SyncMatchesConfig = DEFAULT_SYNC_MATCHES_CONFIG,
): Promise<SyncMatchesResult> {
  return runSync(
    deps,
    {
      provider: config.provider,
      competitionExternalId: config.competitionExternalId,
      season: String(config.season),
      dailyQuotaLimit: config.dailyQuotaLimit,
      perMinuteLimit: config.perMinuteLimit,
    },
    createApiFootballSource(deps.client, config),
  );
}

/**
 * Sincronización con football-data.org: la ventana móvil de la agenda
 * (WAT-189) se calcula UNA vez por corrida a partir del reloj inyectado.
 */
export async function syncFootballDataOrgMatches(
  deps: SyncFootballDataOrgDeps,
  config: SyncFootballDataOrgConfig = DEFAULT_SYNC_FOOTBALL_DATA_ORG_CONFIG,
): Promise<SyncMatchesResult> {
  const window = agendaWindow(deps.clock.now());

  return runSync(
    deps,
    {
      provider: config.provider,
      competitionExternalId: config.competitionExternalId,
      season: config.season,
      dailyQuotaLimit: config.dailyQuotaLimit,
      perMinuteLimit: config.perMinuteLimit,
    },
    createFootballDataOrgSource(deps.client, config, window),
  );
}
