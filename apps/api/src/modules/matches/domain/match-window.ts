/**
 * Ventana temporal del listado de partidos: instantes ISO 8601 en UTC, con
 * inicio inclusivo y fin exclusivo.
 */
export interface MatchWindow {
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cuántos días hacia adelante, sin contar hoy, entran en la agenda. */
const UPCOMING_DAYS = 7;

/**
 * Ventana móvil de la agenda (WAT-189): desde las 00:00 UTC de ayer hasta las
 * 00:00 UTC del día posterior a los próximos siete días. Entran ayer, hoy y
 * los siete días siguientes; el mismo criterio que usa la importación.
 */
export function agendaWindow(now: Date): MatchWindow {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return {
    from: new Date(startOfToday - DAY_MS).toISOString(),
    to: new Date(startOfToday + (UPCOMING_DAYS + 1) * DAY_MS).toISOString(),
  };
}
