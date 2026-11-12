import type { ApiFootballFetchOutcome } from '../../matches/infrastructure/api-football-client.js';
import { normalizeKickoffAt } from '../../matches/application/api-football-normalizer.js';
import type {
  GoalEvent,
  GoalEventKind,
  MatchGoals,
  MatchStatistics,
  TeamSide,
  TeamStatistics,
} from '../domain/match-enrichment.js';

/**
 * Normalización de las respuestas de API-Football para el enriquecimiento histórico:
 * el fixture (para verificar la correspondencia), las estadísticas y los eventos de gol.
 *
 * Regla común: nada de lo que venga mal formado se «arregla» en silencio. Un dato ausente es
 * `null`, nunca cero; una lista que no se puede conciliar con el marcador se marca incompleta.
 */

export type EnrichmentFetchErrorReason =
  | 'timeout'
  | 'network-error'
  | 'rate-limited'
  | 'http-error'
  | 'invalid-json'
  | 'provider-errors'
  | 'invalid-response-shape'
  | 'teams-do-not-match';

export interface EnrichmentFetchError {
  kind: 'error';
  reason: EnrichmentFetchErrorReason;
  /** Mensaje del proveedor cuando lo hay (p. ej. el rechazo del plan). Nunca contiene secretos. */
  providerMessage?: string;
}

type Envelope = { kind: 'ok'; items: unknown[] } | EnrichmentFetchError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Texto del campo `errors` de API-Football (objeto `{clave: mensaje}` o arreglo), o `null` si no hay. */
function readProviderErrors(errors: unknown): { keys: string[]; message: string } | null {
  if (Array.isArray(errors)) {
    const messages = errors.filter(isNonEmptyString);
    return errors.length === 0 ? null : { keys: [], message: messages.join('; ') };
  }

  if (isRecord(errors)) {
    const keys = Object.keys(errors);
    if (keys.length === 0) return null;

    const message = keys
      .map((key) => errors[key])
      .filter(isNonEmptyString)
      .join('; ');

    return { keys, message };
  }

  return null;
}

/**
 * API-Football puede responder HTTP 200 con el motivo en `errors` (límite por minuto, plan sin
 * acceso a la temporada…): un 200 no alcanza para dar un pedido por bueno.
 */
function readEnvelope(outcome: ApiFootballFetchOutcome): Envelope {
  if (outcome.kind === 'timeout') return { kind: 'error', reason: 'timeout' };
  if (outcome.kind === 'network-error') return { kind: 'error', reason: 'network-error' };

  if (outcome.status === 429) return { kind: 'error', reason: 'rate-limited' };
  if (!outcome.ok) return { kind: 'error', reason: 'http-error' };

  const body = outcome.body;
  if (body === undefined) return { kind: 'error', reason: 'invalid-json' };
  if (!isRecord(body)) return { kind: 'error', reason: 'invalid-response-shape' };

  const providerErrors = readProviderErrors(body.errors);
  if (providerErrors) {
    const limited = providerErrors.keys.some((key) => /^(rate|requests)$/i.test(key));

    return {
      kind: 'error',
      reason: limited ? 'rate-limited' : 'provider-errors',
      ...(providerErrors.message ? { providerMessage: providerErrors.message } : {}),
    };
  }

  if (!Array.isArray(body.response)) return { kind: 'error', reason: 'invalid-response-shape' };

  return { kind: 'ok', items: body.response };
}

/**
 * ¿Vale la pena reintentar este pedido una vez? Sólo ante un timeout o un límite de pedidos
 * (HTTP 429 o `errors.rate` dentro de un 200): un rechazo del plan o un error HTTP no mejora
 * repitiéndolo.
 */
export function isRetryableEnrichmentOutcome(outcome: ApiFootballFetchOutcome): boolean {
  const envelope = readEnvelope(outcome);

  return (
    envelope.kind === 'error' &&
    (envelope.reason === 'timeout' || envelope.reason === 'rate-limited')
  );
}

// ---------------------------------------------------------------------------------------------
// Fixture (verificación de la correspondencia)
// ---------------------------------------------------------------------------------------------

export interface FixtureInfo {
  fixtureId: number;
  /** ISO 8601 UTC. */
  kickoffAt: string;
  leagueId: number;
  leagueName: string;
  /** Año de inicio de la temporada tal como lo entiende API-Football. */
  season: number;
  /** Estado corto del proveedor (`FT`, `AET`, `PEN`, `NS`, …). */
  statusShort: string;
  home: { id: number; name: string };
  away: { id: number; name: string };
  /** Goles que informa el proveedor; `null` si no los informa. */
  goals: { home: number; away: number } | null;
  /**
   * `GET /fixtures?id=` puede traer `statistics` y `events` embebidos, con la misma forma que sus
   * endpoints propios. `null` si la respuesta no los trae: entonces hay que pedirlos aparte.
   */
  embeddedStatistics: unknown[] | null;
  embeddedEvents: unknown[] | null;
}

/** Envuelve una lista embebida con la forma de una respuesta de endpoint, para normalizarla igual. */
export function embeddedOutcome(items: unknown[]): ApiFootballFetchOutcome {
  return {
    kind: 'response',
    status: 200,
    ok: true,
    body: { errors: [], results: items.length, response: items },
    paging: undefined,
    headers: {},
  };
}

export type FixtureLookupResult =
  { kind: 'ok'; fixture: FixtureInfo } | { kind: 'not-found' } | EnrichmentFetchError;

export function normalizeFixtureLookup(outcome: ApiFootballFetchOutcome): FixtureLookupResult {
  const envelope = readEnvelope(outcome);
  if (envelope.kind === 'error') return envelope;

  if (envelope.items.length === 0) return { kind: 'not-found' };
  // Pedimos un fixture por id: más de uno es una respuesta ambigua, no se elige uno.
  if (envelope.items.length > 1) return { kind: 'error', reason: 'invalid-response-shape' };

  const raw = envelope.items[0];
  if (!isRecord(raw)) return { kind: 'error', reason: 'invalid-response-shape' };

  const fixture = isRecord(raw.fixture) ? raw.fixture : undefined;
  const league = isRecord(raw.league) ? raw.league : undefined;
  const teams = isRecord(raw.teams) ? raw.teams : undefined;
  const home = isRecord(teams?.home) ? teams.home : undefined;
  const away = isRecord(teams?.away) ? teams.away : undefined;
  const status = isRecord(fixture?.status) ? fixture.status : undefined;
  const kickoffAt = normalizeKickoffAt(fixture?.date);

  if (
    !isPositiveInteger(fixture?.id) ||
    kickoffAt === null ||
    !isPositiveInteger(league?.id) ||
    !isNonEmptyString(league?.name) ||
    !isPositiveInteger(league?.season) ||
    !isNonEmptyString(status?.short) ||
    !isPositiveInteger(home?.id) ||
    !isNonEmptyString(home?.name) ||
    !isPositiveInteger(away?.id) ||
    !isNonEmptyString(away?.name)
  ) {
    return { kind: 'error', reason: 'invalid-response-shape' };
  }

  const rawGoals = isRecord(raw.goals) ? raw.goals : undefined;
  const goals =
    isNonNegativeInteger(rawGoals?.home) && isNonNegativeInteger(rawGoals?.away)
      ? { home: rawGoals.home, away: rawGoals.away }
      : null;

  return {
    kind: 'ok',
    fixture: {
      fixtureId: fixture.id,
      kickoffAt,
      leagueId: league.id,
      leagueName: league.name,
      season: league.season,
      statusShort: status.short,
      home: { id: home.id, name: home.name },
      away: { id: away.id, name: away.name },
      goals,
      embeddedStatistics: Array.isArray(raw.statistics) ? raw.statistics : null,
      embeddedEvents: Array.isArray(raw.events) ? raw.events : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Estadísticas
// ---------------------------------------------------------------------------------------------

export type StatisticsResult =
  | { kind: 'ok'; statistics: MatchStatistics; discarded: string[] }
  | /** Respuesta válida pero sin ningún dato utilizable: no hay cobertura, no son ceros. */ {
      kind: 'unavailable';
    }
  | EnrichmentFetchError;

const EMPTY_TEAM_STATISTICS: TeamStatistics = {
  possessionPct: null,
  totalShots: null,
  shotsOnGoal: null,
  cornerKicks: null,
  fouls: null,
};

type MetricKey = keyof TeamStatistics;

const METRIC_BY_PROVIDER_TYPE: Readonly<Record<string, MetricKey>> = {
  'Ball Possession': 'possessionPct',
  'Total Shots': 'totalShots',
  'Shots on Goal': 'shotsOnGoal',
  'Corner Kicks': 'cornerKicks',
  Fouls: 'fouls',
};

const METRIC_KEYS: readonly MetricKey[] = Object.values(METRIC_BY_PROVIDER_TYPE);

/** `"55%"` o `55` → 55. Fuera de 0–100, con otra forma o sin dato → `null`. */
function parsePercentage(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined) return null;

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d{1,3}(\.\d+)?%$/.test(value.trim())) {
    parsed = Number(value.trim().slice(0, -1));
  } else {
    return 'invalid';
  }

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 'invalid';
}

/** Entero >= 0 (número o texto numérico). `null` es «sin dato»; lo demás es inválido. */
function parseCount(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (isNonNegativeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());

  return 'invalid';
}

// El porcentaje de posesión de los dos equipos tiene que sumar ~100; un redondeo de cada lado
// justifica una pequeña tolerancia.
const POSSESSION_SUM_TOLERANCE = 2;

export function normalizeFixtureStatistics(
  outcome: ApiFootballFetchOutcome,
  teamIds: { home: number; away: number },
): StatisticsResult {
  const envelope = readEnvelope(outcome);
  if (envelope.kind === 'error') return envelope;
  if (envelope.items.length === 0) return { kind: 'unavailable' };

  const bySide: Partial<Record<TeamSide, TeamStatistics>> = {};
  const discarded: string[] = [];

  for (const raw of envelope.items) {
    const team = isRecord(raw) && isRecord(raw.team) ? raw.team : undefined;
    const entries = isRecord(raw) ? raw.statistics : undefined;

    if (!isPositiveInteger(team?.id) || !Array.isArray(entries)) {
      return { kind: 'error', reason: 'invalid-response-shape' };
    }

    const side: TeamSide | null =
      team.id === teamIds.home ? 'home' : team.id === teamIds.away ? 'away' : null;
    // Un equipo que no es ninguno de los dos del partido: la orientación no se puede garantizar.
    if (side === null || bySide[side] !== undefined) {
      return { kind: 'error', reason: 'teams-do-not-match' };
    }

    const stats: TeamStatistics = { ...EMPTY_TEAM_STATISTICS };

    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.type !== 'string') continue;

      const metric = Object.hasOwn(METRIC_BY_PROVIDER_TYPE, entry.type)
        ? METRIC_BY_PROVIDER_TYPE[entry.type]
        : undefined;
      if (metric === undefined) continue;

      const parsed =
        metric === 'possessionPct' ? parsePercentage(entry.value) : parseCount(entry.value);

      if (parsed === 'invalid') {
        discarded.push(`${side}.${metric}`);
        continue;
      }

      stats[metric] = parsed;
    }

    bySide[side] = stats;
  }

  const home = bySide.home ?? { ...EMPTY_TEAM_STATISTICS };
  const away = bySide.away ?? { ...EMPTY_TEAM_STATISTICS };

  if (
    home.possessionPct !== null &&
    away.possessionPct !== null &&
    Math.abs(home.possessionPct + away.possessionPct - 100) > POSSESSION_SUM_TOLERANCE
  ) {
    home.possessionPct = null;
    away.possessionPct = null;
    discarded.push('possessionPct (no suma 100)');
  }

  const hasAnyValue = [home, away].some((stats) =>
    METRIC_KEYS.some((metric) => stats[metric] !== null),
  );
  if (!hasAnyValue) return { kind: 'unavailable' };

  const complete = [home, away].every((stats) => METRIC_KEYS.every((key) => stats[key] !== null));

  return {
    kind: 'ok',
    statistics: { coverage: complete ? 'complete' : 'partial', home, away },
    discarded,
  };
}

// ---------------------------------------------------------------------------------------------
// Goles
// ---------------------------------------------------------------------------------------------

export type GoalsResult =
  | {
      kind: 'ok';
      goals: MatchGoals;
      /** Cómo se concilió con el marcador (para el reporte/evidencia). */
      reconciliation: string;
    }
  | /** Sin eventos utilizables y sin forma de comprobar que el partido no tuvo goles. */ {
      kind: 'unavailable';
    }
  | EnrichmentFetchError;

interface RawGoalEvent {
  kind: GoalEventKind;
  /** Lado del equipo que figura en el evento. */
  teamSide: TeamSide;
  teamId: number;
  playerName: string | null;
  minute: number;
  extraMinute: number | null;
  order: number;
}

const GAME_GOAL_KINDS: ReadonlySet<GoalEventKind> = new Set(['goal', 'own_goal', 'penalty_goal']);

function isGameGoal(kind: GoalEventKind): boolean {
  return GAME_GOAL_KINDS.has(kind);
}

function opposite(side: TeamSide): TeamSide {
  return side === 'home' ? 'away' : 'home';
}

/** Un gol se anula con un evento VAR «Goal cancelled» / «Goal Disallowed - …». */
const CANCELLED_DETAIL = /^goal\s+(cancelled|disallowed)/i;

function classifyEvent(
  type: unknown,
  detail: unknown,
  comments: unknown,
): GoalEventKind | 'ignore' | 'malformed' {
  const isShootout = typeof comments === 'string' && /penalty\s+shootout/i.test(comments);

  if (type === 'Goal') {
    if (typeof detail !== 'string') return 'malformed';
    // Un penal errado no es un gol (ni del juego ni de la tanda).
    if (detail === 'Missed Penalty') return 'ignore';
    if (detail === 'Normal Goal' || detail === 'Penalty' || detail === 'Own Goal') {
      if (isShootout) return 'shootout_goal';
      if (detail === 'Own Goal') return 'own_goal';
      return detail === 'Penalty' ? 'penalty_goal' : 'goal';
    }

    return 'malformed';
  }

  if (type === 'Var' && typeof detail === 'string' && CANCELLED_DETAIL.test(detail)) {
    return 'goal_cancelled';
  }

  return 'ignore';
}

function readEvents(
  items: unknown[],
  teamIds: { home: number; away: number },
): { events: RawGoalEvent[]; malformed: number } | EnrichmentFetchError {
  const events: RawGoalEvent[] = [];
  let malformed = 0;

  items.forEach((raw, order) => {
    if (!isRecord(raw)) {
      malformed += 1;
      return;
    }

    const kind = classifyEvent(raw.type, raw.detail, raw.comments);
    if (kind === 'ignore') return;

    const team = isRecord(raw.team) ? raw.team : undefined;
    const time = isRecord(raw.time) ? raw.time : undefined;
    const player = isRecord(raw.player) ? raw.player : undefined;

    if (kind === 'malformed' || !isPositiveInteger(team?.id)) {
      malformed += 1;
      return;
    }

    const elapsed = time?.elapsed;
    const extra = time?.extra ?? null;
    if (
      !isNonNegativeInteger(elapsed) ||
      elapsed > 200 ||
      !(extra === null || (isNonNegativeInteger(extra) && extra <= 60))
    ) {
      malformed += 1;
      return;
    }

    events.push({
      kind,
      teamSide: team.id === teamIds.home ? 'home' : team.id === teamIds.away ? 'away' : 'home',
      teamId: team.id,
      playerName: isNonEmptyString(player?.name) ? player.name.trim() : null,
      minute: elapsed,
      extraMinute: extra,
      order,
    });
  });

  if (events.some((event) => event.teamId !== teamIds.home && event.teamId !== teamIds.away)) {
    return { kind: 'error', reason: 'teams-do-not-match' };
  }

  return { events, malformed };
}

interface Resolution {
  events: GoalEvent[];
  tally: { home: number; away: number };
}

/**
 * Resuelve a qué lado se acredita cada evento según una interpretación:
 *  - `ownGoalCredit`: en un gol en contra el evento trae el equipo del jugador (`opponent`: el gol
 *    se acredita al rival) o ya el equipo beneficiado (`self`). API-Football no lo aclara, así
 *    que se prueba contra el marcador en vez de suponerlo.
 *  - `pairCancelled`: un «Goal cancelled» anula el gol del mismo equipo en el mismo minuto, que el
 *    proveedor a veces también deja listado como gol.
 *  - `shootout`: si el marcador del partido ya incluye los penales de la tanda.
 */
function resolve(
  events: readonly RawGoalEvent[],
  options: { ownGoalCredit: 'opponent' | 'self'; pairCancelled: boolean; shootoutInScore: boolean },
): Resolution {
  // Goles ya anulados por una anulación, y anulaciones que ya consumieron un gol. Cada anulación
  // consume a lo sumo UN gol: dos anulaciones del mismo equipo y minuto con un solo gol listado
  // dejan una anulación sin emparejar, que se sigue mostrando como tal.
  const paired = new Set<number>();
  const consumedCancellations = new Set<number>();

  if (options.pairCancelled) {
    for (const cancelled of events.filter((event) => event.kind === 'goal_cancelled')) {
      const candidate = events.find(
        (event) =>
          isGameGoal(event.kind) &&
          !paired.has(event.order) &&
          event.teamId === cancelled.teamId &&
          event.minute === cancelled.minute &&
          event.extraMinute === cancelled.extraMinute,
      );

      if (candidate) {
        paired.add(candidate.order);
        consumedCancellations.add(cancelled.order);
      }
    }
  }

  const tally = { home: 0, away: 0 };
  const resolved: GoalEvent[] = [];

  for (const event of events) {
    // El evento VAR que ya se resolvió contra un gol listado no se repite como anulación aparte.
    const kind: GoalEventKind = paired.has(event.order) ? 'goal_cancelled' : event.kind;
    const side =
      kind === 'own_goal' && options.ownGoalCredit === 'opponent'
        ? opposite(event.teamSide)
        : event.teamSide;

    // La anulación que ya se resolvió contra un gol se muestra sobre ese gol, no como una segunda
    // entrada; una sin gol que anular sigue apareciendo.
    if (consumedCancellations.has(event.order)) continue;

    resolved.push({
      kind,
      side,
      playerName: event.playerName,
      minute: event.minute,
      extraMinute: event.extraMinute,
    });

    if (isGameGoal(kind) || (kind === 'shootout_goal' && options.shootoutInScore)) {
      tally[side] += 1;
    }
  }

  return { events: resolved, tally };
}

/** Cronológico: por minuto y añadido; los empates conservan el orden del proveedor. La tanda va al final. */
function sortChronologically(events: readonly GoalEvent[]): GoalEvent[] {
  const decorated = events.map((event, index) => ({ event, index }));

  decorated.sort((a, b) => {
    const shootout =
      Number(a.event.kind === 'shootout_goal') - Number(b.event.kind === 'shootout_goal');
    if (shootout !== 0) return shootout;

    return (
      a.event.minute - b.event.minute ||
      (a.event.extraMinute ?? 0) - (b.event.extraMinute ?? 0) ||
      a.index - b.index
    );
  });

  return decorated.map(({ event }) => event);
}

export function normalizeFixtureGoals(
  outcome: ApiFootballFetchOutcome,
  teamIds: { home: number; away: number },
  score: { home: number; away: number } | null,
): GoalsResult {
  const envelope = readEnvelope(outcome);
  if (envelope.kind === 'error') return envelope;

  const read = readEvents(envelope.items, teamIds);
  if ('kind' in read) return read;

  const { events, malformed } = read;
  const relevant = events.length + malformed;

  // Sin ningún evento de gol: sólo es «0–0 real» si el marcador lo confirma. Con goles en el
  // marcador, o sin marcador, la respuesta no tiene cobertura: no es una cronología vacía.
  if (relevant === 0) {
    if (score !== null && score.home === 0 && score.away === 0) {
      return {
        kind: 'ok',
        goals: { coverage: 'complete', events: [] },
        reconciliation: '0–0 confirmado por el marcador',
      };
    }

    return { kind: 'unavailable' };
  }

  if (score === null) {
    const resolution = resolve(events, {
      ownGoalCredit: 'opponent',
      pairCancelled: false,
      shootoutInScore: false,
    });

    return {
      kind: 'ok',
      goals: { coverage: 'incomplete', events: sortChronologically(resolution.events) },
      reconciliation: 'sin marcador para comprobar',
    };
  }

  const hasOwnGoal = events.some((event) => event.kind === 'own_goal');

  // Orden de preferencia: la lectura más literal primero (sin emparejar anulaciones ni contar la
  // tanda en el marcador); sólo si no cierra se prueban las demás.
  const attempts = [
    { pairCancelled: false, shootoutInScore: false },
    { pairCancelled: true, shootoutInScore: false },
    { pairCancelled: false, shootoutInScore: true },
    { pairCancelled: true, shootoutInScore: true },
  ];

  for (const attempt of attempts) {
    const matching = (['opponent', 'self'] as const)
      .map((ownGoalCredit) => ({
        ownGoalCredit,
        resolution: resolve(events, { ownGoalCredit, ...attempt }),
      }))
      .filter(
        ({ resolution }) =>
          resolution.tally.home === score.home && resolution.tally.away === score.away,
      );

    if (matching.length === 0) continue;

    // Con goles en contra, si las dos lecturas cierran con atribuciones distintas no hay forma de
    // saber a quién se acredita cada uno: no se afirma una cronología completa.
    const first = matching[0]!;
    const ambiguous =
      hasOwnGoal &&
      matching.length > 1 &&
      JSON.stringify(matching[0]!.resolution.events) !==
        JSON.stringify(matching[1]!.resolution.events);

    if (ambiguous) {
      return {
        kind: 'ok',
        goals: { coverage: 'incomplete', events: sortChronologically(first.resolution.events) },
        reconciliation: 'atribución de goles en contra ambigua',
      };
    }

    const notes = [
      attempt.pairCancelled ? 'anulaciones emparejadas con su gol' : null,
      attempt.shootoutInScore ? 'el marcador incluye la tanda de penales' : null,
      hasOwnGoal
        ? `gol en contra: evento = ${first.ownGoalCredit === 'opponent' ? 'equipo del autor' : 'equipo beneficiado'}`
        : null,
    ].filter((note): note is string => note !== null);

    return {
      kind: 'ok',
      goals: {
        coverage: malformed === 0 ? 'complete' : 'incomplete',
        events: sortChronologically(first.resolution.events),
      },
      reconciliation:
        malformed === 0
          ? `coincide con el marcador ${score.home}–${score.away}${notes.length ? ` (${notes.join('; ')})` : ''}`
          : `eventos de gol con forma inválida: ${malformed}`,
    };
  }

  const fallback = resolve(events, {
    ownGoalCredit: 'opponent',
    pairCancelled: false,
    shootoutInScore: false,
  });

  return {
    kind: 'ok',
    goals: { coverage: 'incomplete', events: sortChronologically(fallback.events) },
    reconciliation: `no coincide con el marcador ${score.home}–${score.away} (${fallback.tally.home}–${fallback.tally.away} en los eventos)`,
  };
}
