/**
 * Error de persistencia contra Supabase, para `rooms`.
 *
 * Mismo criterio que `ProfilePersistenceError` de `modules/profiles`:
 * `message` es siempre un texto propio, nunca interpola el error crudo de
 * Supabase/Postgres, para que ningún detalle interno llegue a una respuesta
 * HTTP. Se define de nuevo acá para no acoplar este módulo a la
 * infraestructura interna de otro.
 *
 * El error original queda en `cause` únicamente para diagnóstico en logs de
 * servidor.
 */
export class RoomPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RoomPersistenceError';

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
