import { MATCH_STATUSES, type MatchStatus } from './types';

/**
 * Etiquetas de estado en un único lugar: Home y detalle no las vuelven a
 * declarar.
 */
export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  scheduled: 'Programado',
  live: 'En vivo',
  finished: 'Finalizado',
  postponed: 'Postergado',
  cancelled: 'Cancelado',
};

export function matchStatusLabel(status: MatchStatus): string {
  return MATCH_STATUS_LABELS[status];
}

export function isMatchStatus(value: unknown): value is MatchStatus {
  return MATCH_STATUSES.includes(value as MatchStatus);
}

/**
 * La API entrega el horario en UTC. Se muestra siempre en hora de Argentina y
 * con formato local, sin depender de la configuración del dispositivo: así la
 * misma fecha se lee igual en cualquier máquina y las pruebas son estables.
 *
 * `hour12: false` es explícito a propósito: según la versión de ICU, `es-AR`
 * puede resolver a reloj de 12 horas («06:00 p. m.»), y en Argentina los
 * horarios de los partidos se leen en 24.
 */
const LOCALE = 'es-AR';
const TIME_ZONE = 'America/Argentina/Buenos_Aires';

const kickoffFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const kickoffDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const kickoffTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function format(formatter: Intl.DateTimeFormat, kickoffAt: string): string {
  const date = new Date(kickoffAt);

  // Una fecha ilegible se devuelve tal cual: la pantalla nunca rompe ni inventa
  // un horario que no existe.
  return Number.isNaN(date.getTime()) ? kickoffAt : formatter.format(date);
}

export function formatKickoff(kickoffAt: string): string {
  return format(kickoffFormatter, kickoffAt);
}

export function formatKickoffDate(kickoffAt: string): string {
  return format(kickoffDateFormatter, kickoffAt);
}

export function formatKickoffTime(kickoffAt: string): string {
  return format(kickoffTimeFormatter, kickoffAt);
}
