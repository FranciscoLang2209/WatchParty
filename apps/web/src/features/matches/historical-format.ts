import type { GoalEntry, GoalKind } from './types';

const LOCALE = 'es-AR';
const TIME_ZONE = 'America/Argentina/Buenos_Aires';

const numberFormatter = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

const fetchedDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export const NO_DATA = 'Sin dato';

/**
 * Una métrica ausente (`null`) es «Sin dato»; un `0` es un cero real y se muestra como `0`.
 * Nunca se convierte una en la otra.
 */
export function formatMetric(value: number | null): string {
  return value === null ? NO_DATA : numberFormatter.format(value);
}

export function formatPossession(value: number | null): string {
  return value === null ? NO_DATA : `${numberFormatter.format(value)} %`;
}

/** Minuto con añadido: 45 + 2 → «45+2'», 90 + 4 → «90+4'», sin añadido → «73'». */
export function formatGoalMinute(minute: number, extraMinute: number | null): string {
  return extraMinute !== null && extraMinute > 0 ? `${minute}+${extraMinute}'` : `${minute}'`;
}

/** Lo mismo, dicho para un lector de pantalla («minuto 45 más 2 de añadido»). */
export function spokenGoalMinute(minute: number, extraMinute: number | null): string {
  return extraMinute !== null && extraMinute > 0
    ? `minuto ${minute} más ${extraMinute} de añadido`
    : `minuto ${minute}`;
}

const KIND_LABELS: Record<GoalKind, string | null> = {
  goal: null,
  own_goal: 'gol en contra',
  penalty_goal: 'de penal',
  goal_cancelled: 'anulado',
  shootout_goal: 'convertido',
};

export function goalKindLabel(kind: GoalKind): string | null {
  return KIND_LABELS[kind];
}

export function goalPlayer(entry: GoalEntry): string {
  return entry.playerName ?? 'Autor no informado';
}

/** Fecha (día, mes y año) en hora de Argentina, para «consultado el …». */
export function formatFetchedDate(iso: string): string {
  return fetchedDateFormatter.format(new Date(iso));
}

/** La más reciente de las fechas de consulta de cada parte cargada. */
export function latestFetchedAt(...instants: (string | undefined)[]): string | null {
  const valid = instants.filter((value): value is string => value !== undefined);
  if (valid.length === 0) return null;

  return valid.reduce((latest, current) =>
    Date.parse(current) > Date.parse(latest) ? current : latest,
  );
}
