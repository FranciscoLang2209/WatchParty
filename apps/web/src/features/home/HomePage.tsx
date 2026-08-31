/**
 * Home privada. Es deliberadamente un lienzo vacío: el Header, la navegación
 * inferior y el catálogo de partidos llegan en tickets posteriores.
 *
 * No realiza llamadas HTTP ni consulta Supabase. La sesión la resuelve el guard
 * de rutas privadas, no esta página.
 */
export function HomePage() {
  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <h1 className="sr-only">Inicio</h1>
    </section>
  );
}
