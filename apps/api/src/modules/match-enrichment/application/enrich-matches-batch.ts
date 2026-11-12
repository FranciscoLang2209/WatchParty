import type { ApiFootballClient } from '../../matches/infrastructure/api-football-client.js';
import type { ApiFootballFetchOutcome } from '../../matches/infrastructure/api-football-client.js';
import type { QuotaReservationResult } from '../../matches/domain/match-store.js';
import type { SyncClock } from '../../matches/application/sync-matches.js';
import {
  ENRICHMENT_PROVIDER,
  type EnrichmentMatchRef,
  type GoalsCoverage,
  type MatchEnrichmentPayload,
  type MatchEnrichmentStore,
  type MatchStatistics,
  type StatisticsCoverage,
  type TeamStatistics,
} from '../domain/match-enrichment.js';
import {
  isRetryableEnrichmentOutcome,
  normalizeFixtureGoals,
  normalizeFixtureLookup,
  normalizeFixtureStatistics,
  type EnrichmentFetchError,
  type FixtureInfo,
} from './api-football-enrichment-normalizer.js';
import { verifyCorrespondence, type Rejection } from './enrichment-linking.js';
import type { EnrichmentEntry } from './enrichment-manifest.js';

/**
 * Importación administrativa por lote de estadísticas y goles sobre partidos YA guardados.
 *
 * Nunca crea ni reemplaza partidos ni equipos: sólo vincula un partido existente con su fixture
 * del proveedor complementario y le agrega estadísticas y cronología de goles. No usa el
 * importador de fixtures. Con `dryRun` hace las mismas consultas (que consumen cuota) y reporta
 * qué guardaría, sin escribir nada.
 */

/** Presupuesto propio de la app para API-Football (el plan Free anuncia 100 por día y 10 por minuto). */
export const ENRICHMENT_DAILY_QUOTA_LIMIT = 80;
export const ENRICHMENT_PER_MINUTE_LIMIT = 10;

const PER_MINUTE_WINDOW_MS = 60_000;
const FALLBACK_RETRY_DELAY_MS = 1_000;
// Un reintento como máximo: más allá, el pedido se da por fallido en vez de insistir.
const MAX_RETRY_WAIT_MS = 60_000;

export interface EnrichmentQuota {
  reserveProviderQuotaUnit(
    provider: string,
    quotaDateUtc: string,
    dailyLimit: number,
  ): Promise<QuotaReservationResult>;
}

export type EnrichmentClient = Pick<
  ApiFootballClient,
  'fetchFixtureById' | 'fetchFixtureStatistics' | 'fetchFixtureEvents'
>;

export interface EnrichMatchesDeps {
  client: EnrichmentClient;
  store: MatchEnrichmentStore;
  quota: EnrichmentQuota;
  clock: SyncClock;
}

export interface EnrichMatchesOptions {
  dryRun: boolean;
  dailyQuotaLimit?: number;
  perMinuteLimit?: number;
}

// ---------------------------------------------------------------------------------------------
// Control de pedidos: cuota diaria persistente + límite por minuto + un reintento
// ---------------------------------------------------------------------------------------------

type GateResult =
  { kind: 'quota-exhausted' } | { kind: 'outcome'; outcome: ApiFootballFetchOutcome };

interface RequestGate {
  /** Cada llamada a `request` (reintentos incluidos) reserva una unidad antes de salir. */
  request(call: () => Promise<ApiFootballFetchOutcome>): Promise<GateResult>;
  readonly stats: {
    /** Pedidos realmente hechos al proveedor. */
    requestsMade: number;
    /** Contador diario del ledger tras la última reserva. */
    lastReservedCount: number | null;
    /** Último «restante diario» que informó el proveedor en sus encabezados. */
    providerRemaining: number | null;
    providerLimit: number | null;
  };
}

function toUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readNumberHeader(outcome: ApiFootballFetchOutcome, name: string): number | null {
  if (outcome.kind !== 'response') return null;

  const raw = outcome.headers[name];
  if (raw === undefined) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryDelayMs(outcome: ApiFootballFetchOutcome, now: Date): number {
  const retryAfter = outcome.kind === 'response' ? outcome.headers['retry-after'] : undefined;

  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - now.getTime(), 0), MAX_RETRY_WAIT_MS);
  }

  return FALLBACK_RETRY_DELAY_MS;
}

export function createRequestGate(
  deps: Pick<EnrichMatchesDeps, 'quota' | 'clock'>,
  limits: { dailyQuotaLimit: number; perMinuteLimit: number },
): RequestGate {
  let timestamps: number[] = [];
  const stats: RequestGate['stats'] = {
    requestsMade: 0,
    lastReservedCount: null,
    providerRemaining: null,
    providerLimit: null,
  };

  async function attempt(call: () => Promise<ApiFootballFetchOutcome>): Promise<GateResult> {
    // Si el proveedor ya informó que no queda cuota, ni se intenta: no se gasta otro pedido.
    if (stats.providerRemaining !== null && stats.providerRemaining <= 0) {
      return { kind: 'quota-exhausted' };
    }

    for (;;) {
      const nowMs = deps.clock.now().getTime();
      timestamps = timestamps.filter((timestamp) => nowMs - timestamp < PER_MINUTE_WINDOW_MS);
      if (timestamps.length < limits.perMinuteLimit) break;

      await deps.clock.sleep(PER_MINUTE_WINDOW_MS - (nowMs - timestamps[0]!));
    }

    const reservation = await deps.quota.reserveProviderQuotaUnit(
      ENRICHMENT_PROVIDER,
      toUtcDate(deps.clock.now()),
      limits.dailyQuotaLimit,
    );
    stats.lastReservedCount = reservation.reservedCount;
    if (!reservation.reserved) return { kind: 'quota-exhausted' };

    timestamps.push(deps.clock.now().getTime());
    const outcome = await call();
    stats.requestsMade += 1;

    const remaining = readNumberHeader(outcome, 'x-ratelimit-requests-remaining');
    if (remaining !== null) stats.providerRemaining = remaining;
    const limit = readNumberHeader(outcome, 'x-ratelimit-requests-limit');
    if (limit !== null) stats.providerLimit = limit;

    return { kind: 'outcome', outcome };
  }

  return {
    stats,
    async request(call) {
      const first = await attempt(call);
      if (first.kind === 'quota-exhausted' || !isRetryableEnrichmentOutcome(first.outcome)) {
        return first;
      }

      await deps.clock.sleep(retryDelayMs(first.outcome, deps.clock.now()));

      // El reintento también reserva y cuenta como un pedido más.
      return attempt(call);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------------------------

export type PartStatus =
  'guardado' | 'guardaria' | 'conservado' | 'sin-cobertura' | 'error' | 'no-consultado';

export interface PartReport {
  status: PartStatus;
  coverage?: StatisticsCoverage | GoalsCoverage;
  detail?: string;
}

export type EntryOutcome = 'enriquecido' | 'sin-cobertura' | 'rechazado' | 'error';

export interface EntryEvidence {
  fixtureLeague?: { id: number; name: string; season: number };
  matchKickoffAt?: string;
  fixtureKickoffAt?: string;
  homeTeam?: { internal: string; provider: string };
  awayTeam?: { internal: string; provider: string };
  fixtureStatus?: string;
  statisticsPresent?: string[];
  statisticsAbsent?: string[];
  goalsStored?: number;
  goalsReconciliation?: string;
  notes?: string[];
}

export interface EntryReport {
  matchId: string;
  fixtureId: number;
  outcome: EntryOutcome;
  /** Motivos de rechazo o de error, en texto presentable (sin secretos). */
  reasons: string[];
  statistics: PartReport;
  goals: PartReport;
  /** Pedidos que se hicieron al proveedor por este partido. */
  requests: number;
  evidence: EntryEvidence;
}

export interface EnrichBatchReport {
  dryRun: boolean;
  entries: EntryReport[];
  totals: {
    enriquecidos: number;
    sinCobertura: number;
    rechazados: number;
    errores: number;
  };
  quota: {
    requestsMade: number;
    dailyLimit: number;
    /** Contador diario del ledger propio tras la última reserva (todas las corridas del día). */
    reservedToday: number | null;
    providerRemaining: number | null;
    providerLimit: number | null;
    exhausted: boolean;
  };
  /** Cantidad de partidos antes y después: el enriquecimiento no debe cambiarla. */
  matchesBefore: number;
  matchesAfter: number;
  exitCode: 0 | 1;
}

const STATISTIC_FIELDS: readonly (keyof TeamStatistics)[] = [
  'possessionPct',
  'totalShots',
  'shotsOnGoal',
  'cornerKicks',
  'fouls',
];

function describeStatisticsFields(statistics: MatchStatistics): {
  present: string[];
  absent: string[];
} {
  const present: string[] = [];
  const absent: string[] = [];

  for (const side of ['home', 'away'] as const) {
    for (const field of STATISTIC_FIELDS) {
      (statistics[side][field] === null ? absent : present).push(`${side}.${field}`);
    }
  }

  return { present, absent };
}

const STATISTICS_RANK: Record<StatisticsCoverage, number> = { partial: 1, complete: 2 };
const GOALS_RANK: Record<GoalsCoverage, number> = { incomplete: 1, complete: 2 };

/**
 * Una carga nueva reemplaza a la guardada sólo si es tan completa como ella: una respuesta
 * incompleta nunca pisa datos ya confirmados, y una corrección válida (igual o mejor) sí.
 */
function shouldReplace<C extends string>(
  stored: C | null,
  incoming: C,
  rank: Record<C, number>,
): boolean {
  return stored === null || rank[incoming] >= rank[stored];
}

const FETCH_ERROR_TEXT: Record<EnrichmentFetchError['reason'], string> = {
  timeout: 'el proveedor no respondió a tiempo',
  'network-error': 'falló la conexión con el proveedor',
  'rate-limited': 'el proveedor limitó los pedidos',
  'http-error': 'el proveedor respondió con un error HTTP',
  'invalid-json': 'la respuesta del proveedor no es JSON',
  'provider-errors': 'el proveedor rechazó el pedido',
  'invalid-response-shape': 'la respuesta del proveedor tiene una forma inesperada',
  'teams-do-not-match': 'los equipos de la respuesta no coinciden con los del partido',
};

function describeFetchError(error: EnrichmentFetchError): string {
  const base = FETCH_ERROR_TEXT[error.reason];
  return error.providerMessage ? `${base}: ${error.providerMessage}` : base;
}

function emptyPart(status: PartStatus = 'no-consultado'): PartReport {
  return { status };
}

function formatRejection(rejection: Rejection): string {
  return `${rejection.code}: ${rejection.message}`;
}

// ---------------------------------------------------------------------------------------------
// Un partido
// ---------------------------------------------------------------------------------------------

type EntryRun = Omit<EntryReport, 'matchId' | 'fixtureId' | 'requests'>;

function failedEntry(
  outcome: EntryOutcome,
  reasons: string[],
  evidence: EntryEvidence = {},
): EntryRun {
  return { outcome, reasons, statistics: emptyPart(), goals: emptyPart(), evidence };
}

async function processEntry(
  deps: EnrichMatchesDeps,
  gate: RequestGate,
  entry: EnrichmentEntry,
  options: EnrichMatchesOptions,
): Promise<EntryRun> {
  const match = await deps.store.findMatchForEnrichment(entry.matchId);
  if (match === null) {
    return failedEntry('rechazado', [
      'partido-inexistente: el matchId no existe; este comando nunca crea partidos',
    ]);
  }

  // La correspondencia ya guardada no se reasigna en silencio.
  const ownerOfFixture = await deps.store.findMatchIdByFixture(
    ENRICHMENT_PROVIDER,
    String(entry.fixtureId),
  );
  if (ownerOfFixture !== null && ownerOfFixture !== match.id) {
    return failedEntry('rechazado', [
      `fixture-ya-vinculado: el fixture ${entry.fixtureId} ya pertenece a otro partido (${ownerOfFixture})`,
    ]);
  }

  const linkedFixture = await deps.store.findFixtureByMatch(ENRICHMENT_PROVIDER, match.id);
  if (linkedFixture !== null && linkedFixture !== String(entry.fixtureId)) {
    return failedEntry('rechazado', [
      `partido-ya-vinculado: el partido ya está vinculado al fixture ${linkedFixture}, no al ${entry.fixtureId}`,
    ]);
  }

  // 1) El fixture: para verificar que sea ese partido antes de gastar pedidos en sus datos.
  const fixtureGate = await gate.request(() =>
    deps.client.fetchFixtureById({ fixtureId: entry.fixtureId }),
  );
  if (fixtureGate.kind === 'quota-exhausted') {
    return failedEntry('error', ['cuota-agotada: no quedan pedidos disponibles para continuar']);
  }

  const lookup = normalizeFixtureLookup(fixtureGate.outcome);
  if (lookup.kind === 'error') {
    return failedEntry('error', [`fixture: ${describeFetchError(lookup)}`]);
  }
  if (lookup.kind === 'not-found') {
    return failedEntry('rechazado', [
      `fixture-inexistente: el proveedor no tiene el fixture ${entry.fixtureId}`,
    ]);
  }

  const fixture = lookup.fixture;
  const evidence = buildBaseEvidence(match, fixture);

  const verdict = verifyCorrespondence(match, fixture);
  if (!verdict.accepted) {
    return failedEntry('rechazado', verdict.rejections.map(formatRejection), evidence);
  }
  evidence.notes = verdict.notes;

  const teamIds = { home: fixture.home.id, away: fixture.away.id };
  const stored = await deps.store.getStoredState(ENRICHMENT_PROVIDER, match.id);
  const payload: MatchEnrichmentPayload = {};
  const reasons: string[] = [];

  // 2) Estadísticas.
  const statisticsGate = await gate.request(() =>
    deps.client.fetchFixtureStatistics({ fixtureId: entry.fixtureId }),
  );
  let statisticsPart: PartReport;

  if (statisticsGate.kind === 'quota-exhausted') {
    statisticsPart = { status: 'error', detail: 'cuota agotada' };
    reasons.push('cuota-agotada: no se consultaron las estadísticas');
  } else {
    const result = normalizeFixtureStatistics(statisticsGate.outcome, teamIds);

    if (result.kind === 'error') {
      statisticsPart = { status: 'error', detail: describeFetchError(result) };
      reasons.push(`estadísticas: ${describeFetchError(result)}`);
    } else if (result.kind === 'unavailable') {
      statisticsPart = {
        status: 'sin-cobertura',
        detail: 'el proveedor no devolvió estadísticas utilizables',
      };
    } else {
      const fields = describeStatisticsFields(result.statistics);
      evidence.statisticsPresent = fields.present;
      evidence.statisticsAbsent = fields.absent;

      const discarded = result.discarded.length
        ? `valores descartados por inválidos: ${result.discarded.join(', ')}`
        : undefined;

      if (shouldReplace(stored.statisticsCoverage, result.statistics.coverage, STATISTICS_RANK)) {
        payload.statistics = result.statistics;
        statisticsPart = {
          status: options.dryRun ? 'guardaria' : 'guardado',
          coverage: result.statistics.coverage,
          ...(discarded ? { detail: discarded } : {}),
        };
      } else {
        statisticsPart = {
          status: 'conservado',
          coverage: result.statistics.coverage,
          detail: `se conservan las ya guardadas (${stored.statisticsCoverage}): la respuesta es menos completa`,
        };
      }
    }
  }

  // 3) Goles.
  const goalsGate = await gate.request(() =>
    deps.client.fetchFixtureEvents({ fixtureId: entry.fixtureId }),
  );
  let goalsPart: PartReport;

  if (goalsGate.kind === 'quota-exhausted') {
    goalsPart = { status: 'error', detail: 'cuota agotada' };
    reasons.push('cuota-agotada: no se consultaron los goles');
  } else {
    const result = normalizeFixtureGoals(goalsGate.outcome, teamIds, match.score);

    if (result.kind === 'error') {
      goalsPart = { status: 'error', detail: describeFetchError(result) };
      reasons.push(`goles: ${describeFetchError(result)}`);
    } else if (result.kind === 'unavailable') {
      goalsPart = {
        status: 'sin-cobertura',
        detail: 'el proveedor no devolvió eventos de gol que se puedan comprobar con el marcador',
      };
    } else {
      evidence.goalsStored = result.goals.events.length;
      evidence.goalsReconciliation = result.reconciliation;

      if (shouldReplace(stored.goalsCoverage, result.goals.coverage, GOALS_RANK)) {
        payload.goals = result.goals;
        goalsPart = {
          status: options.dryRun ? 'guardaria' : 'guardado',
          coverage: result.goals.coverage,
          detail: result.reconciliation,
        };
      } else {
        goalsPart = {
          status: 'conservado',
          coverage: result.goals.coverage,
          detail: `se conserva la cronología ya guardada (${stored.goalsCoverage}): la respuesta es menos completa`,
        };
      }
    }
  }

  // Sólo se escribe con dry_run=false, y sólo lo que corresponde a un partido ya verificado. Una
  // parte ausente del payload no se toca: un error o una respuesta incompleta nunca borra nada.
  // El vínculo solo se registra aparte si el proveedor confirmó que no hay datos; tras un error
  // (cuota, red…) no se escribe nada, para no dejar un partido «consultado» sin haberlo estado.
  const anyPartFailed = statisticsPart.status === 'error' || goalsPart.status === 'error';
  const hasSomethingToWrite =
    payload.statistics !== undefined ||
    payload.goals !== undefined ||
    (linkedFixture === null && !anyPartFailed);

  if (!options.dryRun && hasSomethingToWrite) {
    try {
      await deps.store.saveEnrichment({
        matchId: match.id,
        provider: ENRICHMENT_PROVIDER,
        fixtureId: String(entry.fixtureId),
        fetchedAt: deps.clock.now().toISOString(),
        payload,
      });
    } catch (error) {
      // Si no se pudo guardar nada se informa como error de escritura, no como «guardado».
      const message = error instanceof Error ? error.message : 'error desconocido';
      return {
        outcome: 'error',
        reasons: [...reasons, `escritura: ${message}`],
        statistics:
          statisticsPart.status === 'guardado'
            ? { ...statisticsPart, status: 'error' }
            : statisticsPart,
        goals: goalsPart.status === 'guardado' ? { ...goalsPart, status: 'error' } : goalsPart,
        evidence,
      };
    }
  }

  const parts = [statisticsPart, goalsPart];
  const outcome: EntryOutcome = parts.some((part) => part.status === 'error')
    ? 'error'
    : parts.every((part) => part.status === 'sin-cobertura')
      ? 'sin-cobertura'
      : 'enriquecido';

  return { outcome, reasons, statistics: statisticsPart, goals: goalsPart, evidence };
}

function buildBaseEvidence(match: EnrichmentMatchRef, fixture: FixtureInfo): EntryEvidence {
  return {
    fixtureLeague: { id: fixture.leagueId, name: fixture.leagueName, season: fixture.season },
    matchKickoffAt: match.kickoffAt,
    fixtureKickoffAt: fixture.kickoffAt,
    homeTeam: { internal: match.homeTeamName, provider: fixture.home.name },
    awayTeam: { internal: match.awayTeamName, provider: fixture.away.name },
    fixtureStatus: fixture.statusShort,
  };
}

// ---------------------------------------------------------------------------------------------
// Lote
// ---------------------------------------------------------------------------------------------

export async function enrichMatchesBatch(
  deps: EnrichMatchesDeps,
  entries: readonly EnrichmentEntry[],
  options: EnrichMatchesOptions,
): Promise<EnrichBatchReport> {
  const dailyQuotaLimit = options.dailyQuotaLimit ?? ENRICHMENT_DAILY_QUOTA_LIMIT;
  const gate = createRequestGate(deps, {
    dailyQuotaLimit,
    perMinuteLimit: options.perMinuteLimit ?? ENRICHMENT_PER_MINUTE_LIMIT,
  });

  const matchesBefore = await deps.store.countMatches();
  const reports: EntryReport[] = [];
  let exhausted = false;

  for (const entry of entries) {
    const before = gate.stats.requestsMade;
    let run: EntryRun;

    if (exhausted) {
      // Con la cuota agotada no se intenta nada más: ni se consulta ni se escribe.
      run = failedEntry('error', ['cuota-agotada: no se procesó por falta de pedidos disponibles']);
    } else {
      run = await processEntry(deps, gate, entry, options);
      exhausted = run.reasons.some((reason) => reason.startsWith('cuota-agotada'));
    }

    reports.push({
      matchId: entry.matchId,
      fixtureId: entry.fixtureId,
      requests: gate.stats.requestsMade - before,
      ...run,
    });
  }

  const matchesAfter = await deps.store.countMatches();
  const count = (outcome: EntryOutcome) => reports.filter((r) => r.outcome === outcome).length;
  const countChanged = matchesAfter !== matchesBefore;

  return {
    dryRun: options.dryRun,
    entries: reports,
    totals: {
      enriquecidos: count('enriquecido'),
      sinCobertura: count('sin-cobertura'),
      rechazados: count('rechazado'),
      errores: count('error'),
    },
    quota: {
      requestsMade: gate.stats.requestsMade,
      dailyLimit: dailyQuotaLimit,
      reservedToday: gate.stats.lastReservedCount,
      providerRemaining: gate.stats.providerRemaining,
      providerLimit: gate.stats.providerLimit,
      exhausted,
    },
    matchesBefore,
    matchesAfter,
    exitCode:
      !countChanged &&
      reports.every((r) => r.outcome === 'enriquecido' || r.outcome === 'sin-cobertura')
        ? 0
        : 1,
  };
}

/** Tabla Markdown del reporte, lista para pegar como evidencia o mostrar en el resumen del Action. */
export function formatEnrichBatchTable(report: EnrichBatchReport): string {
  const header = [
    '| Partido | Fixture | Resultado | Estadísticas | Goles | Pedidos | Detalle |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  const part = (p: PartReport) => (p.coverage ? `${p.status} (${p.coverage})` : p.status);

  const rows = report.entries.map((entry) => {
    const detail = [...entry.reasons, entry.statistics.detail, entry.goals.detail]
      .filter((text): text is string => text !== undefined && text !== '')
      .join(' · ')
      .replace(/\|/g, '/');

    return `| ${entry.matchId} | ${entry.fixtureId} | ${entry.outcome} | ${part(entry.statistics)} | ${part(entry.goals)} | ${entry.requests} | ${detail || '—'} |`;
  });

  const t = report.totals;
  const q = report.quota;
  const summary = [
    '',
    `Modo: ${report.dryRun ? 'dry_run (no se escribió nada)' : 'escritura'}`,
    `Enriquecidos: ${t.enriquecidos} · Sin cobertura: ${t.sinCobertura} · Rechazados/ambiguos: ${t.rechazados} · Errores: ${t.errores}`,
    `Cuota: ${q.requestsMade} pedidos en esta corrida · ${q.reservedToday ?? '—'}/${q.dailyLimit} reservados hoy` +
      `${q.providerRemaining !== null ? ` · restante informado por el proveedor: ${q.providerRemaining}${q.providerLimit !== null ? `/${q.providerLimit}` : ''}` : ''}` +
      `${q.exhausted ? ' · CUOTA AGOTADA' : ''}`,
    `Partidos antes/después: ${report.matchesBefore}/${report.matchesAfter}${report.matchesBefore === report.matchesAfter ? ' (sin cambios)' : ' (¡CAMBIÓ!)'}`,
  ];

  return [...header, ...rows, ...summary].join('\n');
}
