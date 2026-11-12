import { readWebEnv } from '../../lib/env';
import { isMatchStatus } from './format';
import {
  MatchesApiError,
  type GoalEntry,
  type GoalKind,
  type HistoricalDetail,
  type HistoricalGoals,
  type HistoricalStatistics,
  type Match,
  type MatchEnvelope,
  type MatchesEnvelope,
  type MatchesErrorKind,
  type MatchScore,
  type MatchSearchPage,
  type TeamStatistics,
} from './types';

/**
 * Mensajes presentables. El error del proveedor nunca llega a la pantalla: se
 * traduce acá, en un solo lugar, para que Home y detalle no inventen copy.
 */
const MESSAGES: Record<MatchesErrorKind, string> = {
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unauthorized: 'La sesión venció. Iniciá sesión nuevamente.',
  'not-found': 'No encontramos ese partido.',
  server: 'No pudimos cargar los partidos. Intentá de nuevo.',
  cancelled: 'Consulta cancelada.',
};

const KIND_BY_API_CODE: Record<string, MatchesErrorKind> = {
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  INTERNAL_ERROR: 'server',
};

/** Quita las barras finales de la base para no construir `//matches`. */
function matchesUrl(path = ''): string {
  return `${readWebEnv().apiBaseUrl.replace(/\/+$/, '')}/matches${path}`;
}

function fail(kind: MatchesErrorKind): MatchesApiError {
  return new MatchesApiError(kind, MESSAGES[kind]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function kindFromStatus(status: number): MatchesErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return 'server';
}

/**
 * Prefiere el código del contrato de errores de la API y cae al status HTTP si
 * el cuerpo no es el esperado (por ejemplo, un proxy devolviendo HTML).
 */
async function toApiError(response: Response): Promise<MatchesApiError> {
  let code: unknown;

  try {
    const body: unknown = await response.json();
    code =
      typeof body === 'object' && body !== null
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined;
  } catch {
    code = undefined;
  }

  const mapped = typeof code === 'string' ? KIND_BY_API_CODE[code] : undefined;

  return fail(mapped ?? kindFromStatus(response.status));
}

function isGoalCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * `null` es «sin resultado». Una API anterior que no envía el campo también
 * se lee como sin resultado. `undefined` señala un marcador con forma
 * inválida: el partido no cumple el contrato.
 */
function parseScore(value: unknown): MatchScore | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return undefined;

  const { home, away } = value as Record<string, unknown>;

  return isGoalCount(home) && isGoalCount(away) ? { home, away } : undefined;
}

/**
 * Se queda con los campos canónicos y descarta cualquier extra. `null` si no
 * es un partido válido: no lanza, así otra feature que recibe partidos
 * anidados (p. ej. el historial de vistos, WAT-218) lo traduce a su propio
 * error.
 */
export function parseMatch(value: unknown): Match | null {
  if (typeof value !== 'object' || value === null) return null;

  const { id, homeTeam, homeTeamId, awayTeam, awayTeamId, kickoffAt, status, score } =
    value as Record<string, unknown>;
  const parsedScore = parseScore(score);

  if (
    typeof id !== 'string' ||
    typeof homeTeam !== 'string' ||
    typeof homeTeamId !== 'string' ||
    typeof awayTeam !== 'string' ||
    typeof awayTeamId !== 'string' ||
    typeof kickoffAt !== 'string' ||
    !isMatchStatus(status) ||
    parsedScore === undefined
  ) {
    return null;
  }

  return {
    id,
    homeTeam,
    homeTeamId,
    awayTeam,
    awayTeamId,
    kickoffAt,
    status,
    score: parsedScore,
  };
}

function toMatch(value: unknown): Match {
  const match = parseMatch(value);

  if (!match) throw fail('server');

  return match;
}

async function request<T>(url: string, accessToken: string, signal?: AbortSignal): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
  } catch (error) {
    // Cancelar no es un fallo de red: la pantalla que desmonta no debe avisar.
    throw isAbortError(error) ? fail('cancelled') : fail('network');
  }

  if (!response.ok) throw await toApiError(response);

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw isAbortError(error) ? fail('cancelled') : fail('server');
  }
}

export async function listMatches(accessToken: string, signal?: AbortSignal): Promise<Match[]> {
  const body = await request<MatchesEnvelope>(matchesUrl(), accessToken, signal);

  if (typeof body !== 'object' || body === null || !Array.isArray(body.matches)) {
    throw fail('server');
  }

  return body.matches.map(toMatch);
}

export async function getMatch(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Match> {
  // El id es opaco: se codifica sin interpretarlo.
  const body = await request<MatchEnvelope>(
    matchesUrl(`/${encodeURIComponent(matchId)}`),
    accessToken,
    signal,
  );

  if (typeof body !== 'object' || body === null) throw fail('server');

  return toMatch(body.match);
}

export interface SearchMatchesOptions {
  /** El `nextCursor` de la página anterior; sin él se pide la primera. */
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Busca partidos persistidos por parte del nombre de un equipo (WAT-240). El
 * texto se codifica como parámetro: viaja tal cual lo escribió la persona.
 */
export async function searchMatches(
  text: string,
  accessToken: string,
  { cursor, limit, signal }: SearchMatchesOptions = {},
): Promise<MatchSearchPage> {
  const params = new URLSearchParams({ q: text });

  if (limit !== undefined) params.set('limit', String(limit));
  if (cursor !== undefined) params.set('cursor', cursor);

  const body = await request<MatchSearchPage>(
    matchesUrl(`/search?${params.toString()}`),
    accessToken,
    signal,
  );

  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray(body.matches) ||
    (body.nextCursor !== null && typeof body.nextCursor !== 'string')
  ) {
    throw fail('server');
  }

  return { matches: body.matches.map(toMatch), nextCursor: body.nextCursor };
}

// ---------------------------------------------------------------------------------------------
// Detalle histórico (estadísticas y goles)
// ---------------------------------------------------------------------------------------------

const GOAL_KINDS: readonly GoalKind[] = [
  'goal',
  'own_goal',
  'penalty_goal',
  'goal_cancelled',
  'shootout_goal',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Una métrica es un número válido o `null` (sin dato). Un valor de otro tipo, un número fuera de
 * rango o un negativo invalidan la respuesta: nunca se «arregla» convirtiéndolo en 0.
 */
function parseMetric(value: unknown, max?: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (max !== undefined && value > max) return undefined;

  return value;
}

function parseTeamStatistics(value: unknown): TeamStatistics | undefined {
  if (!isRecord(value)) return undefined;

  const possessionPct = parseMetric(value.possessionPct, 100);
  const totalShots = parseMetric(value.totalShots);
  const shotsOnGoal = parseMetric(value.shotsOnGoal);
  const cornerKicks = parseMetric(value.cornerKicks);
  const fouls = parseMetric(value.fouls);

  if (
    possessionPct === undefined ||
    totalShots === undefined ||
    shotsOnGoal === undefined ||
    cornerKicks === undefined ||
    fouls === undefined ||
    // Los conteos son enteros; sólo la posesión puede tener decimales.
    [totalShots, shotsOnGoal, cornerKicks, fouls].some(
      (count) => count !== null && !Number.isInteger(count),
    )
  ) {
    return undefined;
  }

  return { possessionPct, totalShots, shotsOnGoal, cornerKicks, fouls };
}

function parseStatistics(value: unknown): HistoricalStatistics | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const home = parseTeamStatistics(value.home);
  const away = parseTeamStatistics(value.away);

  if (
    (value.coverage !== 'complete' && value.coverage !== 'partial') ||
    !isIsoInstant(value.fetchedAt) ||
    home === undefined ||
    away === undefined
  ) {
    return undefined;
  }

  return { coverage: value.coverage, fetchedAt: value.fetchedAt, home, away };
}

function parseGoalEntry(value: unknown): GoalEntry | undefined {
  if (!isRecord(value)) return undefined;

  const { kind, side, playerName, minute, extraMinute } = value;

  if (
    !GOAL_KINDS.includes(kind as GoalKind) ||
    (side !== 'home' && side !== 'away') ||
    !(playerName === null || (typeof playerName === 'string' && playerName.trim() !== '')) ||
    typeof minute !== 'number' ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    !(
      extraMinute === null ||
      (typeof extraMinute === 'number' && Number.isInteger(extraMinute) && extraMinute >= 0)
    )
  ) {
    return undefined;
  }

  return { kind: kind as GoalKind, side, playerName, minute, extraMinute };
}

function parseGoalList(value: unknown, allowed: readonly GoalKind[]): GoalEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value.map(parseGoalEntry);

  // Una lista con un elemento inválido no se muestra a medias: sería una cronología parcial
  // presentada como si estuviera completa.
  if (entries.some((entry) => entry === undefined || !allowed.includes(entry.kind))) {
    return undefined;
  }

  return entries as GoalEntry[];
}

function parseGoals(value: unknown): HistoricalGoals | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const goals = parseGoalList(value.goals, ['goal', 'own_goal', 'penalty_goal']);
  const cancelled = parseGoalList(value.cancelled, ['goal_cancelled']);
  const shootout = parseGoalList(value.shootout, ['shootout_goal']);

  if (
    (value.coverage !== 'complete' && value.coverage !== 'incomplete') ||
    !isIsoInstant(value.fetchedAt) ||
    goals === undefined ||
    cancelled === undefined ||
    shootout === undefined
  ) {
    return undefined;
  }

  return { coverage: value.coverage, fetchedAt: value.fetchedAt, goals, cancelled, shootout };
}

/**
 * Se queda con los campos del contrato y valida cada uno. `null` = el partido no tiene detalle
 * cargado. Una forma inválida no se corrige: lanza el mismo error recuperable que cualquier
 * respuesta inesperada del servidor.
 */
export function parseHistoricalDetail(value: unknown): HistoricalDetail | null {
  if (value === null) return null;
  if (!isRecord(value)) throw fail('server');

  const statistics = parseStatistics(value.statistics);
  const goals = parseGoals(value.goals);

  if (
    value.source !== 'api-football' ||
    value.historical !== true ||
    statistics === undefined ||
    goals === undefined
  ) {
    throw fail('server');
  }

  return { source: 'api-football', historical: true, statistics, goals };
}

/**
 * Estadísticas y goles guardados de un partido terminado. Sólo lee lo ya cargado por el equipo:
 * nunca dispara una consulta al proveedor externo.
 */
export async function getHistoricalDetail(
  matchId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<HistoricalDetail | null> {
  const body = await request<{ detail?: unknown }>(
    matchesUrl(`/${encodeURIComponent(matchId)}/historical-detail`),
    accessToken,
    signal,
  );

  if (!isRecord(body) || !('detail' in body)) throw fail('server');

  return parseHistoricalDetail(body.detail);
}
