import { useCallback, useEffect, useId, useState } from 'react';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { MatchCard } from '@/features/matches/MatchCard';
import { listMatches } from '@/features/matches/api';
import { MatchesApiError, isCancelled, type Match } from '@/features/matches/types';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; matches: Match[] }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar el directorio. Intentá de nuevo.';

/**
 * /rooms sólo muestra partidos que todavía pueden tener sala activa, repartidos en
 * secciones por el estado que ya devuelve el catálogo. Un partido pertenece a una
 * sola sección y, dentro de ella, conserva el orden con que llegó de la API.
 */
const SECCIONES: readonly { estado: Match['status']; titulo: string }[] = [
  { estado: 'live', titulo: 'En vivo' },
  { estado: 'scheduled', titulo: 'Próximos' },
];

function seccionesVisibles(matches: Match[]) {
  return SECCIONES.map(({ estado, titulo }) => ({
    estado,
    titulo,
    matches: matches.filter((match) => match.status === estado),
  })).filter((seccion) => seccion.matches.length > 0);
}

function SeccionPartidos({ titulo, matches }: { titulo: string; matches: Match[] }) {
  const tituloId = useId();

  return (
    <section aria-labelledby={tituloId} className="flex w-full min-w-0 flex-col gap-3">
      <h2 id={tituloId} className="font-display text-xl leading-tight font-semibold">
        {titulo}
      </h2>

      <ul className="grid w-full list-none grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {matches.map((match) => (
          <li key={match.id} className="w-full min-w-0">
            <MatchCard match={match} headingLevel="h3" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function toEstadoError(error: unknown): Estado {
  if (error instanceof MatchesApiError) {
    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Directorio de salas (WAT-144, F3.2.1): reutiliza el catálogo de partidos ya
 * expuesto por la API — no hay una fuente de datos nueva. El render de cada
 * partido como tarjeta (F3.2.2) y el estado vacío explícito (F3.2.3) llegan
 * en los tickets siguientes de esta misma cadena.
 */
export function RoomsDirectoryPage() {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null) return;

    const controller = new AbortController();
    let vigente = true;

    listMatches(accessToken, controller.signal)
      .then((matches) => {
        if (vigente) setEstado({ status: 'ready', matches });
      })
      .catch((error: unknown) => {
        if (!vigente || isCancelled(error)) return;

        setEstado(toEstadoError(error));
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [accessToken, intento]);

  const reintentar = useCallback(() => {
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  const secciones = estado.status === 'ready' ? seccionesVisibles(estado.matches) : [];

  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex min-w-0 flex-col gap-2">
          <h1 className="font-display text-3xl leading-tight font-semibold break-words sm:text-4xl">
            Salas
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            Elegí un partido en vivo o próximo para entrar a su sala.
          </p>
        </header>

        {estado.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando el directorio…
          </p>
        ) : null}

        {estado.status === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{estado.message}</p>

            {estado.expired ? (
              <Button type="button" onClick={() => void signOut()}>
                Iniciar sesión nuevamente
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={reintentar}>
                Reintentar
              </Button>
            )}
          </div>
        ) : null}

        {estado.status === 'ready' && secciones.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay partidos ni salas disponibles. Volvé más tarde.
          </p>
        ) : null}

        {secciones.map(({ estado: estadoPartido, titulo, matches }) => (
          <SeccionPartidos key={estadoPartido} titulo={titulo} matches={matches} />
        ))}
      </div>
    </section>
  );
}
