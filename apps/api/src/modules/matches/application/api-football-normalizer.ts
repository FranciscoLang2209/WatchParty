import type {
  NormalizedFixtureStatus,
  NormalizedSportsFixture,
} from './normalized-sports-fixture.js';
import type { ApiFootballFetchOutcome } from '../infrastructure/api-football-client.js';

export type SkippedFixtureReason =
  | 'invalid-fixture-id'
  | 'invalid-league-id'
  | 'invalid-league-name'
  | 'invalid-season'
  | 'invalid-home-team'
  | 'invalid-away-team'
  | 'invalid-kickoff-date'
  | 'unrepresentable-status';

export interface SkippedFixture {
  reason: SkippedFixtureReason;
}

export type NormalizationErrorReason =
  | 'http-error'
  | 'timeout'
  | 'network-error'
  | 'invalid-json'
  | 'provider-errors'
  | 'invalid-response-shape'
  | 'invalid-results'
  | 'invalid-paging';

export type NormalizationResult =
  | {
      kind: 'success';
      paging: { current: number; total: number };
      fixtures: NormalizedSportsFixture[];
      skipped: SkippedFixture[];
    }
  | { kind: 'error'; reason: NormalizationErrorReason };

const STATUS_MAP: Record<string, NormalizedFixtureStatus> = {
  NS: 'scheduled',
  TBD: 'scheduled',
  '1H': 'live',
  HT: 'live',
  '2H': 'live',
  ET: 'live',
  BT: 'live',
  P: 'live',
  LIVE: 'live',
  FT: 'finished',
  AET: 'finished',
  PEN: 'finished',
  PST: 'postponed',
  CANC: 'cancelled',
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeKickoffAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function isValidErrorsField(errors: unknown): boolean {
  if (Array.isArray(errors)) return errors.length === 0;
  if (typeof errors === 'object' && errors !== null) return Object.keys(errors).length === 0;
  return false;
}

function normalizePaging(paging: unknown): { current: number; total: number } | null {
  if (typeof paging !== 'object' || paging === null) return null;

  const { current, total } = paging as Record<string, unknown>;

  if (!isPositiveInteger(current) || !isPositiveInteger(total)) return null;

  return { current, total };
}

function normalizeFixture(
  raw: unknown,
): { ok: true; fixture: NormalizedSportsFixture } | { ok: false; reason: SkippedFixtureReason } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'invalid-fixture-id' };
  }

  const record = raw as Record<string, unknown>;
  const fixture = record.fixture as Record<string, unknown> | undefined;
  const league = record.league as Record<string, unknown> | undefined;
  const teams = record.teams as Record<string, unknown> | undefined;

  const externalFixtureId = fixture?.id;
  if (!isPositiveInteger(externalFixtureId)) {
    return { ok: false, reason: 'invalid-fixture-id' };
  }

  const kickoffAt = normalizeKickoffAt(fixture?.date);
  if (kickoffAt === null) {
    return { ok: false, reason: 'invalid-kickoff-date' };
  }

  const statusShort = (fixture?.status as Record<string, unknown> | undefined)?.short;
  const status = typeof statusShort === 'string' ? STATUS_MAP[statusShort] : undefined;
  if (status === undefined) {
    return { ok: false, reason: 'unrepresentable-status' };
  }

  const externalLeagueId = league?.id;
  if (!isPositiveInteger(externalLeagueId)) {
    return { ok: false, reason: 'invalid-league-id' };
  }

  const externalLeagueName = league?.name;
  if (!isNonEmptyString(externalLeagueName)) {
    return { ok: false, reason: 'invalid-league-name' };
  }

  const season = league?.season;
  if (!isPositiveInteger(season)) {
    return { ok: false, reason: 'invalid-season' };
  }

  const home = teams?.home as Record<string, unknown> | undefined;
  if (!isPositiveInteger(home?.id) || !isNonEmptyString(home?.name)) {
    return { ok: false, reason: 'invalid-home-team' };
  }

  const away = teams?.away as Record<string, unknown> | undefined;
  if (!isPositiveInteger(away?.id) || !isNonEmptyString(away?.name)) {
    return { ok: false, reason: 'invalid-away-team' };
  }

  return {
    ok: true,
    fixture: {
      provider: 'api-football',
      externalFixtureId,
      externalLeagueId,
      externalLeagueName,
      season,
      homeTeam: { externalTeamId: home!.id as number, name: home!.name as string },
      awayTeam: { externalTeamId: away!.id as number, name: away!.name as string },
      kickoffAt,
      status,
    },
  };
}

export function normalizeApiFootballFixturesPage(
  outcome: ApiFootballFetchOutcome,
): NormalizationResult {
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

  if (!isValidErrorsField(body.errors)) {
    return { kind: 'error', reason: 'provider-errors' };
  }

  if (!Array.isArray(body.response)) {
    return { kind: 'error', reason: 'invalid-response-shape' };
  }

  if (!isNonNegativeInteger(body.results)) {
    return { kind: 'error', reason: 'invalid-results' };
  }

  const paging = normalizePaging(body.paging);
  if (paging === null) {
    return { kind: 'error', reason: 'invalid-paging' };
  }

  const fixtures: NormalizedSportsFixture[] = [];
  const skipped: SkippedFixture[] = [];

  for (const rawFixture of body.response) {
    const result = normalizeFixture(rawFixture);

    if (result.ok) {
      fixtures.push(result.fixture);
    } else {
      skipped.push({ reason: result.reason });
    }
  }

  return { kind: 'success', paging, fixtures, skipped };
}
