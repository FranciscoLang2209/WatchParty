/**
 * Error de persistencia contra Supabase, para `reviews`.
 *
 * Mismo criterio que `MatchRatingPersistenceError`: `message` es siempre un
 * texto propio, nunca interpola el error crudo de Supabase/Postgres, para que
 * ningún detalle interno llegue a una respuesta HTTP (el errorHandler
 * responde 500 genérico). El error original queda en `cause` solo para logs.
 */
export class MatchReviewPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MatchReviewPersistenceError';

    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}
