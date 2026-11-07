/**
 * La API entrega las fechas de las opiniones en UTC. Se muestran siempre en
 * hora de Argentina y con formato local, sin depender de la configuración del
 * dispositivo: la misma fecha se lee igual en cualquier máquina y las pruebas
 * son estables (mismo criterio que `matches/format.ts`).
 */
const reviewDateFormatter = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Una fecha ilegible se devuelve tal cual: la pantalla nunca inventa una fecha. */
export function formatReviewDate(createdAt: string): string {
  const date = new Date(createdAt);

  return Number.isNaN(date.getTime()) ? createdAt : reviewDateFormatter.format(date);
}
