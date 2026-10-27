/**
 * Formato del promedio y de la cantidad de votos (WAT-215). Se fija el locale
 * y no se toma el del dispositivo, igual que `features/matches/format.ts`: la
 * misma cifra se lee igual en cualquier máquina y las pruebas son estables.
 */
const LOCALE = 'es-AR';

/** Siempre con una coma decimal y al menos un decimal: 3,5 · 4,0 · 3,67. */
const averageFormatter = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});

export function formatAverage(average: number): string {
  return averageFormatter.format(average);
}

/** «1 voto» en singular; el resto, en plural («0 votos», «4 votos»). */
export function formatVotes(count: number): string {
  return count === 1 ? '1 voto' : `${count} votos`;
}
