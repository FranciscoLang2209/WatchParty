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
 */
export class SupabasePersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SupabasePersistenceError';
  }
}
