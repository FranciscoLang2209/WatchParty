import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatKickoff, matchStatusLabel } from './format';
import { getMatch } from './api';
import { MatchesApiError, isCancelled, type Match } from './types';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; match: Match }
  | { status: 'not-found' }
  | { status: 'error'; message: string; expired: boolean };

const TITULO_NEUTRO = 'Detalle del partido';
const MENSAJE_INESPERADO = 'No pudimos cargar el partido. Intentá de nuevo.';

function toEstadoError(error: unknown): Estado {
  if (error instanceof MatchesApiError) {
    // Un partido inexistente no es un fallo: es una respuesta legítima y se
    // comunica distinto de un error recuperable.
    if (error.kind === 'not-found') return { status: 'not-found' };

    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

function VolverAHome() {
  return (
    <Link
      to="/"
      className="rounded-sm text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      Volver a Home
    </Link>
  );
}

/**
 * Detalle mínimo de un partido.
 *
 * El `matchId` de la URL se pasa al cliente sin interpretarlo: es opaco. Carga,
 * no encontrado, error recuperable y sesión vencida son estados distintos.
 */
export function MatchDetailPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null || matchId === undefined) return;

    const controller = new AbortController();
    let vigente = true;

    getMatch(matchId, accessToken, controller.signal)
      .then((match) => {
        if (vigente) setEstado({ status: 'ready', match });
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje o cambio de token no se anuncia.
        if (!vigente || isCancelled(error)) return;

        setEstado(toEstadoError(error));
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [matchId, accessToken, intento]);

  const reintentar = useCallback(() => {
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  const titulo =
    estado.status === 'ready'
      ? `${estado.match.homeTeam} vs. ${estado.match.awayTeam}`
      : TITULO_NEUTRO;

  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
        <h1 className="min-w-0 text-2xl leading-tight font-semibold break-words sm:text-3xl">
          {titulo}
        </h1>

        {estado.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando el partido…
          </p>
        ) : null}

        {estado.status === 'ready' ? (
          <Card className="gap-2 p-4">
            <p className="text-sm text-muted-foreground">{formatKickoff(estado.match.kickoffAt)}</p>
            <p className="text-base font-semibold">{matchStatusLabel(estado.match.status)}</p>
          </Card>
        ) : null}

        {estado.status === 'not-found' ? (
          <p role="status" className="text-sm text-muted-foreground">
            No encontramos ese partido. Puede haber cambiado o ya no estar disponible.
          </p>
        ) : null}

        {estado.status === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{estado.message}</p>

            {estado.expired ? (
              // La sesión vencida se resuelve con el flujo de Auth existente: al
              // quedar sin sesión, el guard redirige a la pantalla de acceso.
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

        <VolverAHome />
      </div>
    </section>
  );
}
