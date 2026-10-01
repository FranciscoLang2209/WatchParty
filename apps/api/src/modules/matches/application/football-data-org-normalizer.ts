import type { MatchStatus } from '../domain/match.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import type { FootballDataOrgFetchOutcome } from '../infrastructure/football-data-org-client.js';

/**
 * Identifica las filas que vienen de este proveedor en `matches`/`teams`
 * (columna `provider`) — nunca se confunde con 'api-football'.
 */
export const FOOTBALL_DATA_ORG_PROVIDER = 'football-data-org';

export type SkippedFootballDataOrgFixtureReason =
  | 'invalid-match-id'
  | 'invalid-competition-id'
  | 'invalid-season-id'
  | 'invalid-home-team'
  | 'invalid-away-team'
  | 'invalid-kickoff-date'
  | 'unrepresentable-status';

export interface SkippedFootballDataOrgFixture {
  reason: SkippedFootballDataOrgFixtureReason;
}

export type FootballDataOrgNormalizationErrorReason =
  'http-error' | 'timeout' | 'network-error' | 'invalid-json' | 'invalid-response-shape';

export type FootballDataOrgNormalizationResult =
  | {
      kind: 'success';
      fixtures: NormalizedMatchFixture[];
      skipped: SkippedFootballDataOrgFixture[];
    }
  | { kind: 'error'; reason: FootballDataOrgNormalizationErrorReason };

/**
 * Mapea el vocabulario de estados de football-data.org al `MatchStatus`
 * canónico. Confirmado contra la API real
 * (docs/integrations/football-data-org-coverage.md): un partido con horario
 * confirmado llega como "TIMED", no "SCHEDULED" (ese es el valor que acepta
 * el filtro de consulta, no un status real observado en ningún partido).
 *
 * Sólo se mapean los estados con correspondencia clara y verificada. Otros
 * valores del proveedor (p. ej. SUSPENDED, AWARDED) no tienen un equivalente
 * confirmado en nuestro dominio: se omiten explícitamente en vez de
 * adivinar uno.
 */
const STATUS_MAP: Record<string, MatchStatus> = {
  SCHEDULED: 'scheduled',
  TIMED: 'scheduled',
  IN_PLAY: 'live',
  PAUSED: 'live',
  FINISHED: 'finished',
  POSTPONED: 'postponed',
  CANCELLED: 'cancelled',
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Misma validación que api-football-normalizer.ts: Date.parse por sí solo
// acepta formas que ISO 8601 no permite (p. ej. "2023-3-3"), así que primero
// se valida la forma exacta con el regex y recién después se delega el
// cálculo del instante a Date.parse.
function normalizeKickoffAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;

  return new Date(timestamp).toISOString();
}

function normalizeMatch(
  raw: unknown,
):
  | { ok: true; fixture: NormalizedMatchFixture }
  | { ok: false; reason: SkippedFootballDataOrgFixtureReason } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'invalid-match-id' };
  }

  const record = raw as Record<string, unknown>;

  const externalMatchId = record.id;
  if (!isPositiveInteger(externalMatchId)) {
    return { ok: false, reason: 'invalid-match-id' };
  }

  const kickoffAt = normalizeKickoffAt(record.utcDate);
  if (kickoffAt === null) {
    return { ok: false, reason: 'invalid-kickoff-date' };
  }

  const rawStatus = record.status;
  const status =
    typeof rawStatus === 'string' && Object.hasOwn(STATUS_MAP, rawStatus)
      ? STATUS_MAP[rawStatus]
      : undefined;
  if (status === undefined) {
    return { ok: false, reason: 'unrepresentable-status' };
  }

  const competition = record.competition as Record<string, unknown> | undefined;
  const externalCompetitionId = competition?.id;
  if (!isPositiveInteger(externalCompetitionId)) {
    return { ok: false, reason: 'invalid-competition-id' };
  }

  // football-data.org no expone un año de temporada simple (como el
  // `league.season` numérico de API-Football): sólo `season.id`, un
  // identificador interno del proveedor. Se usa tal cual, como string opaco
  // — no se deriva un "año" a partir de otras fechas, para no inventar un
  // dato que el proveedor no entrega directamente.
  const season = record.season as Record<string, unknown> | undefined;
  const externalSeasonId = season?.id;
  if (!isPositiveInteger(externalSeasonId)) {
    return { ok: false, reason: 'invalid-season-id' };
  }

  const home = record.homeTeam as Record<string, unknown> | undefined;
  if (!isPositiveInteger(home?.id) || !isNonEmptyString(home?.name)) {
    return { ok: false, reason: 'invalid-home-team' };
  }

  const away = record.awayTeam as Record<string, unknown> | undefined;
  if (!isPositiveInteger(away?.id) || !isNonEmptyString(away?.name)) {
    return { ok: false, reason: 'invalid-away-team' };
  }

  return {
    ok: true,
    fixture: {
      provider: FOOTBALL_DATA_ORG_PROVIDER,
      externalId: String(externalMatchId),
      homeTeam: { externalId: String(home!.id), name: home!.name as string },
      awayTeam: { externalId: String(away!.id), name: away!.name as string },
      competitionExternalId: String(externalCompetitionId),
      season: String(externalSeasonId),
      kickoffAt,
      status,
    },
  };
}

export function normalizeFootballDataOrgMatches(
  outcome: FootballDataOrgFetchOutcome,
): FootballDataOrgNormalizationResult {
  if (outcome.kind === 'timeout') {
    return { kind: 'error', reason: 'timeout' };
  }

  if (outcome.kind === 'network-error') {
    return { kind: 'error', reason: 'network-error' };
  }

  if (!outcome.ok) {
    return { kind: 'error', reason: 'http-error' };
  }

  if (typeof outcome.body !== 'object' || outcome.body === null) {
    return { kind: 'error', reason: 'invalid-json' };
  }

  const body = outcome.body as Record<string, unknown>;

  if (!Array.isArray(body.matches)) {
    return { kind: 'error', reason: 'invalid-response-shape' };
  }

  const fixtures: NormalizedMatchFixture[] = [];
  const skipped: SkippedFootballDataOrgFixture[] = [];

  for (const rawMatch of body.matches) {
    const result = normalizeMatch(rawMatch);

    if (result.ok) {
      fixtures.push(result.fixture);
    } else {
      skipped.push({ reason: result.reason });
    }
  }

  return { kind: 'success', fixtures, skipped };
}
