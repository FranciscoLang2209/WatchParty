/**
 * Error de persistencia contra Supabase, para `profiles`/`teams`.
 *
 * Mismo criterio que `SupabasePersistenceError` de `modules/matches`
 * (WAT-106): `message` es siempre un texto propio, nunca interpola el
 * error crudo de Supabase/Postgres, para que ningún detalle interno
 * (columnas, SQL) llegue a una respuesta HTTP. Se define de nuevo acá en
 * vez de importar la de `matches` para no acoplar un módulo de dominio
 * (`profiles`) a la infraestructura interna de otro (`matches`).
 *
 * El `errorHandler` global responde 500 genérico ante cualquier error no
 * controlado, así que basta con lanzar esta clase para que un fallo real
 * nunca se sustituya por `[]`, `null` ni datos ficticios.
 *
 * El error original queda en `cause` únicamente para diagnóstico en logs
 * de servidor. Nunca contiene la service_role key ni ningún otro secreto.
 */
export class ProfilePersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProfilePersistenceError';

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
