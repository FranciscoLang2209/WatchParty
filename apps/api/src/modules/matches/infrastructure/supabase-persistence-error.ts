/**
 * Error de persistencia contra Supabase.
 *
 * `message` es siempre un texto propio, sin interpolar el error crudo de
 * Supabase/Postgres: eso evita que el detalle interno de la base (nombres
 * de columnas, SQL, etc.) termine sirializado en una respuesta HTTP. El
 * `errorHandler` global responde con un 500 genérico ante cualquier error
 * no controlado, así que basta con lanzar esta clase (o dejar propagar el
 * error de Supabase) para que la falla nunca se sustituya por `[]`, `null`
 * ni datos ficticios.
 *
 * El error original queda en `cause` únicamente para diagnóstico en logs de
 * servidor (`console.error` en el error handler). Nunca contiene la
 * service_role key ni ningún otro secreto: los errores de Supabase/Postgres
 * no incluyen credenciales, solo detalles de la operación fallida.
 *
 * `cause` se define a mano en vez de usar `super(message, { cause })`
 * (ticket WAT-138): ese overload de dos argumentos de `Error` existe recién
 * desde ES2022, y el build de Vercel lo rechazaba con
 * `TS2554: Expected 0-1 arguments, but got 2`. El descriptor replica el del
 * `cause` nativo — no enumerable, pero escribible y configurable — para que
 * la clase se siga comportando como un `Error` común.
 */
export class SupabasePersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SupabasePersistenceError';

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
