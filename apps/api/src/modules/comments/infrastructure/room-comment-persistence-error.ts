/**
 * Error de persistencia contra Supabase, para `room_comments`.
 *
 * Mismo criterio que `ProfilePersistenceError` (modules/profiles): `message`
 * es siempre texto propio, nunca interpola el error crudo de
 * Supabase/Postgres, para que ningún detalle interno llegue a una respuesta
 * HTTP. El error original queda en `cause` solo para logs de servidor.
 */
export class RoomCommentPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RoomCommentPersistenceError';

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
