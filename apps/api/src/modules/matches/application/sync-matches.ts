import type { MatchStore, SyncLeaseScope, SyncResultDetails } from '../domain/match-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type {
  ApiFootballFetchOutcome,
  FetchFixturesPageParams,
} from '../infrastructure/api-football-client.js';
import type { NormalizedSportsFixture } from './normalized-sports-fixture.js';
import { normalizeApiFootballFixturesPage } from './api-football-normalizer.js';

export interface SyncMatchesClient {
  fetchFixturesPage(
    params: FetchFixturesPageParams,
    signal?: AbortSignal,
  ): Promise<ApiFootballFetchOutcome>;
}

export interface SyncClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface SyncMatchesDeps {
  client: SyncMatchesClient;
  store: MatchStore;
  clock: SyncClock;
  owner: string;
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

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isRetryableOutcome(outcome: ApiFootballFetchOutcome): boolean {
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

function computeRetryDelayMs(outcome: ApiFootballFetchOutcome, now: Date): number {
  if (outcome.kind === 'response') {
    const retryAfter = outcome.headers['retry-after'];
    if (retryAfter !== undefined) {
      const parsed = parseRetryAfterMs(retryAfter, now);
      if (parsed !== null) return parsed;
    }
  }

  return FALLBACK_RETRY_DELAY_MS;
}

function readProviderRemaining(outcome: ApiFootballFetchOutcome): number | null {
  if (outcome.kind !== 'response') return null;

  const raw = outcome.headers['x-ratelimit-requests-remaining'];
  if (raw === undefined) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
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

interface RunState {
  requestTimestampsMs: number[];
  providerObservedRemaining: number | null;
  lastReservedCount: number;
}

type ReservationOutcome =
  { kind: 'quota-exhausted' } | { kind: 'response'; outcome: ApiFootballFetchOutcome };

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
// de esos controles corta el paso, nunca llega a llamar a fetchFixturesPage.
async function reserveAndFetch(
  deps: SyncMatchesDeps,
  config: SyncMatchesConfig,
  page: number,
  state: RunState,
  summary: SyncMatchesSummary,
): Promise<ReservationOutcome> {
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
  const outcome = await deps.client.fetchFixturesPage({
    league: Number(config.competitionExternalId),
    season: config.season,
    from: config.from,
    to: config.to,
    page,
  });
  summary.consultasRealizadas += 1;

  const observedRemaining = readProviderRemaining(outcome);
  if (observedRemaining !== null) {
    state.providerObservedRemaining = observedRemaining;
  }

  return { kind: 'response', outcome };
}

async function fetchPageWithRetryPolicy(
  deps: SyncMatchesDeps,
  config: SyncMatchesConfig,
  page: number,
  state: RunState,
  summary: SyncMatchesSummary,
): Promise<ReservationOutcome> {
  let attempt = await reserveAndFetch(deps, config, page, state, summary);

  if (attempt.kind === 'quota-exhausted') {
    return attempt;
  }

  if (isRetryableOutcome(attempt.outcome)) {
    const delayMs = computeRetryDelayMs(attempt.outcome, deps.clock.now());
    await deps.clock.sleep(delayMs);
    attempt = await reserveAndFetch(deps, config, page, state, summary);
  }

  return attempt;
}

export async function syncMatches(
  deps: SyncMatchesDeps,
  config: SyncMatchesConfig = DEFAULT_SYNC_MATCHES_CONFIG,
): Promise<SyncMatchesResult> {
  const scope: SyncLeaseScope = {
    provider: config.provider,
    competitionExternalId: config.competitionExternalId,
    season: String(config.season),
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
      const attempt = await fetchPageWithRetryPolicy(deps, config, page, state, summary);

      if (attempt.kind === 'quota-exhausted') {
        quotaExhausted = true;
        break;
      }

      const normalized = normalizeApiFootballFixturesPage(attempt.outcome);

      if (normalized.kind === 'error') {
        incrementReasonCount(summary.errores, normalized.reason);
        firstErrorReason ??= normalized.reason;
        break;
      }

      totalPages = normalized.paging.total;

      for (const skipped of normalized.skipped) {
        incrementReasonCount(summary.omitidos, skipped.reason);
      }

      for (const fixture of normalized.fixtures) {
        const result = await deps.store.upsertFixture(toNormalizedMatchFixture(fixture));
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
    const details: SyncResultDetails = { error: firstErrorReason };
    if (state.providerObservedRemaining !== null) {
      details.observedQuotaRemaining = state.providerObservedRemaining;
    }
    await deps.store.recordSyncResult(scope, leaseToken, firstErrorReason === undefined, details);
  }

  summary.presupuestoRestante = Math.max(config.dailyQuotaLimit - state.lastReservedCount, 0);

  const exitCode: 0 | 1 = firstErrorReason !== undefined || quotaExhausted ? 1 : 0;

  return { exitCode, summary };
}
