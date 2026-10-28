import { CalendarX, LoaderCircle, LogIn, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { MatchCard } from '@/features/matches/MatchCard';
import { DirectoryStatePanel } from './DirectoryStatePanel';
import { listMatches } from '@/features/matches/api';
import { MatchesApiError, isCancelled, type Match } from '@/features/matches/types';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; matches: Match[] }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar el directorio. Intentá de nuevo.';

/** /rooms sólo muestra partidos que todavía pueden tener sala activa. */
const ESTADOS_VISIBLES: ReadonlySet<Match['status']> = new Set(['live', 'scheduled']);

function partidosVisibles(matches: Match[]): Match[] {
  return matches.filter((match) => ESTADOS_VISIBLES.has(match.status));
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
  const panelCarga = useRef<HTMLDivElement>(null);
  // Al reintentar, el botón desaparece: el foco pasa al panel de carga para que el
  // teclado y el lector de pantalla no queden en el vacío.
  const reintentando = useRef(false);

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

  useEffect(() => {
    if (estado.status !== 'loading' || !reintentando.current) return;

    reintentando.current = false;
    panelCarga.current?.focus();
  }, [estado.status]);

  const reintentar = useCallback(() => {
    reintentando.current = true;
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  const visibles = estado.status === 'ready' ? partidosVisibles(estado.matches) : [];

  return (
    <section
      aria-busy={estado.status === 'loading'}
      className="flex w-full flex-1 flex-col overflow-x-hidden"
    >
      <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="font-display text-3xl leading-tight font-semibold">Salas</h1>

        {estado.status === 'loading' ? (
          <DirectoryStatePanel
            role="status"
            icon={LoaderCircle}
            spin
            title="Un momento"
            message="Cargando el directorio…"
            panelRef={panelCarga}
          />
        ) : null}

        {estado.status === 'error' && estado.expired ? (
          // La sesión vencida no es un fallo recuperable: se resuelve con el flujo
          // de Auth existente, así que no se ofrece reintentar.
          <DirectoryStatePanel
            role="alert"
            icon={LogIn}
            title="Necesitás ingresar de nuevo"
            message={estado.message}
            action={
              <Button type="button" className="w-full sm:w-auto" onClick={() => void signOut()}>
                Iniciar sesión nuevamente
              </Button>
            }
          />
        ) : null}

        {estado.status === 'error' && !estado.expired ? (
          <DirectoryStatePanel
            role="alert"
            tone="error"
            icon={TriangleAlert}
            title="Algo salió mal"
            message={estado.message}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={reintentar}
              >
                Reintentar
              </Button>
            }
          />
        ) : null}

        {estado.status === 'ready' && visibles.length === 0 ? (
          <DirectoryStatePanel
            icon={CalendarX}
            title="No hay partidos por ahora"
            message="Todavía no hay partidos ni salas disponibles. Volvé más tarde."
          />
        ) : null}

        {estado.status === 'ready' && visibles.length > 0 ? (
          <ul className="grid w-full list-none grid-cols-1 gap-4 sm:grid-cols-2">
            {visibles.map((match) => (
              <li key={match.id} className="w-full min-w-0">
                <MatchCard match={match} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
