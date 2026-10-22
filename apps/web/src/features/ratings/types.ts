/**
 * Espejo del contrato público de la nota propia de un partido de la Node API
 * (`GET` y `PUT /matches/:matchId/rating`, WAT-212), que responde siempre con
 * `{ rating }`: un entero de 1 a 5, o `null` si todavía no calificó (solo en
 * `GET`).
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/watched`.
 */

export const RATING_VALUES = [1, 2, 3, 4, 5] as const;

/** Una nota válida: entero de 1 a 5. No hay medias notas. */
export type RatingValue = (typeof RATING_VALUES)[number];

export function isRatingValue(value: unknown): value is RatingValue {
  return RATING_VALUES.some((rating) => rating === value);
}

/**
 * Motivo por el que falló una operación.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por el
 * flujo de Auth, `not-found` cubre el partido inexistente y `conflict` el
 * partido que (todavía) no admite calificación: no finalizado, o no marcado
 * como visto.
 */
export type RatingsErrorKind =
  'network' | 'unauthorized' | 'not-found' | 'conflict' | 'validation' | 'server' | 'cancelled';

export class RatingsApiError extends Error {
  readonly kind: RatingsErrorKind;

  constructor(kind: RatingsErrorKind, message: string) {
    super(message);
    this.name = 'RatingsApiError';
    this.kind = kind;
  }
}

/** Una operación cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof RatingsApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof RatingsApiError && error.kind === 'unauthorized';
}
