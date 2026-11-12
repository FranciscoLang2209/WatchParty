import type { FootballDataOrgFetchOutcome } from '../infrastructure/football-data-org-client.js';

/**
 * Sondeo de cobertura de selecciones en football-data.org. Responde con datos de la cuenta
 * vigente (no con la página pública del proveedor) a una pregunta concreta: qué torneos de
 * selecciones puede leer la cuenta y si devuelven partidos en una ventana de fechas.
 *
 * Todo lo que sale de acá es seguro de pegar en un ticket: el informe nunca incluye la clave,
 * los encabezados de la respuesta ni el cuerpo completo del proveedor.
 */

/** Orden de los planes del proveedor, de menor a mayor. */
const PLAN_ORDER = ['TIER_ONE', 'TIER_TWO', 'TIER_THREE', 'TIER_FOUR'] as const;
export type FootballDataOrgPlan = (typeof PLAN_ORDER)[number];

export interface ProbeCompetition {
  code: string;
  name: string;
  area: string;
  /** Plan mínimo que el proveedor exige para leerla. */
  plan: string;
  /** Temporada vigente según el proveedor, o `null` si no informa. */
  currentSeason: { startDate: string; endDate: string } | null;
}

/** Torneos de selecciones: mundiales, continentales, eliminatorias, Nations League y amistosos. */
const NATIONAL_TEAMS =
  /world cup|european championship|nations league|qualif|copa am[eé]rica|africa cup|asian cup|gold cup|friendl|international/i;

/** Lo que el patrón anterior alcanza pero no son partidos de selecciones masculinas. */
const NOT_NATIONAL_TEAMS =
  /women|club world cup|champions league|conference league|europa league|olympic|super cup/i;

export function isNationalTeamCompetition(name: string): boolean {
  return NATIONAL_TEAMS.test(name) && !NOT_NATIONAL_TEAMS.test(name);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** De la respuesta de `GET /v4/competitions`, las de selecciones, ordenadas por código. */
export function selectNationalTeamCompetitions(body: unknown): ProbeCompetition[] {
  const competitions = asRecord(body)?.competitions;

  if (!Array.isArray(competitions)) {
    return [];
  }

  const result: ProbeCompetition[] = [];

  for (const raw of competitions) {
    const item = asRecord(raw);
    const name = asString(item?.name);
    const code = asString(item?.code);

    if (!item || !name || !code || !isNationalTeamCompetition(name)) {
      continue;
    }

    const season = asRecord(item.currentSeason);
    const startDate = asString(season?.startDate);
    const endDate = asString(season?.endDate);

    result.push({
      code,
      name,
      area: asString(asRecord(item.area)?.name) ?? '',
      plan: asString(item.plan) ?? 'desconocido',
      currentSeason: startDate && endDate ? { startDate, endDate } : null,
    });
  }

  return result.sort((a, b) => a.code.localeCompare(b.code));
}

/** ¿Un plan mínimo `required` entra en el plan `account` de la cuenta? Desconocido: no. */
export function isWithinPlan(required: string, account: string): boolean {
  const need = PLAN_ORDER.indexOf(required as FootballDataOrgPlan);
  const have = PLAN_ORDER.indexOf(account as FootballDataOrgPlan);

  return need !== -1 && have !== -1 && need <= have;
}

export interface MatchesProbeSummary {
  result: 'ok' | 'rechazado' | 'timeout' | 'error-de-red';
  /** Código HTTP, cuando hubo respuesta. */
  status: number | null;
  matchCount: number | null;
  firstUtcDate: string | null;
  lastUtcDate: string | null;
  /** Mensaje del proveedor, recortado: sirve para ver la restricción, no para filtrar nada. */
  providerMessage: string | null;
}

const MAX_MESSAGE_LENGTH = 160;

/** Reduce la respuesta de `/competitions/:code/matches` a lo que hace falta para el informe. */
export function summarizeMatchesProbe(outcome: FootballDataOrgFetchOutcome): MatchesProbeSummary {
  const empty = { status: null, matchCount: null, firstUtcDate: null, lastUtcDate: null };

  if (outcome.kind === 'timeout') {
    return { ...empty, result: 'timeout', providerMessage: null };
  }

  if (outcome.kind === 'network-error') {
    // El mensaje de red del runtime no lleva la clave, pero tampoco se reproduce: no aporta.
    return { ...empty, result: 'error-de-red', providerMessage: null };
  }

  const body = asRecord(outcome.body);

  if (!outcome.ok) {
    const message = asString(body?.message);

    return {
      ...empty,
      result: 'rechazado',
      status: outcome.status,
      providerMessage: message ? message.slice(0, MAX_MESSAGE_LENGTH) : null,
    };
  }

  const matches = Array.isArray(body?.matches) ? body.matches : [];
  const dates = matches
    .map((match) => asString(asRecord(match)?.utcDate))
    .filter((date): date is string => date !== null)
    .sort();

  return {
    result: 'ok',
    status: outcome.status,
    matchCount: matches.length,
    firstUtcDate: dates[0] ?? null,
    lastUtcDate: dates[dates.length - 1] ?? null,
    providerMessage: null,
  };
}

export interface CompetitionProbeRow {
  competition: ProbeCompetition;
  /** `false` si el plan de la cuenta no alcanza: no se gasta un pedido en consultarla. */
  withinPlan: boolean;
  probe: MatchesProbeSummary | null;
}

export interface CoverageProbeReport {
  accountPlan: string;
  dateFrom: string;
  dateTo: string;
  rows: CompetitionProbeRow[];
}

/** Tabla legible para pegar en el ticket. */
export function formatCoverageProbe(report: CoverageProbeReport): string {
  const lines = [
    `Cobertura de selecciones con el plan ${report.accountPlan} · ventana ${report.dateFrom} a ${report.dateTo}`,
    '',
    'código | competición | plan exigido | temporada vigente | resultado',
  ];

  for (const { competition, withinPlan, probe } of report.rows) {
    const season = competition.currentSeason
      ? `${competition.currentSeason.startDate} → ${competition.currentSeason.endDate}`
      : 'sin temporada vigente';
    let result: string;

    if (!withinPlan) {
      result = `fuera del plan de la cuenta (exige ${competition.plan})`;
    } else if (!probe) {
      result = 'sin consultar';
    } else if (probe.result === 'ok') {
      result =
        probe.matchCount === 0
          ? 'HTTP 200, 0 partidos en la ventana'
          : `HTTP 200, ${probe.matchCount} partidos (${probe.firstUtcDate} a ${probe.lastUtcDate})`;
    } else if (probe.result === 'rechazado') {
      result = `HTTP ${probe.status}${probe.providerMessage ? `: ${probe.providerMessage}` : ''}`;
    } else {
      result = probe.result;
    }

    lines.push(
      `${competition.code} | ${competition.name} | ${competition.plan} | ${season} | ${result}`,
    );
  }

  if (report.rows.length === 0) {
    lines.push('(el proveedor no listó ningún torneo de selecciones)');
  }

  return lines.join('\n');
}
