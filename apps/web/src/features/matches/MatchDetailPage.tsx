import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { enterRoom } from '@/features/rooms/api';
import { RoomsApiError, isCancelled as isRoomCancelled } from '@/features/rooms/types';
import { getWatched, setWatched } from '@/features/watched/api';
import { WatchedApiError, isCancelled as isWatchedCancelled } from '@/features/watched/types';
import { formatKickoff, matchStatusLabel } from './format';
import { getMatch } from './api';
import { MatchesApiError, isCancelled, type Match } from './types';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; match: Match }
  | { status: 'not-found' }
  | { status: 'error'; message: string; expired: boolean };

type ErrorSala = { message: string; expired: boolean };
type ErrorVisto = { message: string; expired: boolean };

const TITULO_NEUTRO = 'Detalle del partido';
const MENSAJE_INESPERADO = 'No pudimos cargar el partido. Intentá de nuevo.';
const MENSAJE_INESPERADO_SALA = 'No pudimos abrir la sala. Intentá de nuevo.';
const MENSAJE_INESPERADO_VISTO = 'No pudimos actualizar el partido visto. Intentá de nuevo.';
const MENSAJE_LECTURA_VISTO = 'No pudimos saber si ya viste este partido. Intentá de nuevo.';

function toEstadoError(error: unknown): Estado {
  if (error instanceof MatchesApiError) {
    // Un partido inexistente no es un fallo: es una respuesta legítima y se
    // comunica distinto de un error recuperable.
    if (error.kind === 'not-found') return { status: 'not-found' };

    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

function toErrorSala(error: unknown): ErrorSala {
  if (error instanceof RoomsApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO_SALA, expired: false };
}

function toErrorVisto(error: unknown): ErrorVisto {
  if (error instanceof WatchedApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO_VISTO, expired: false };
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

interface MarcarVistoProps {
  matchId: string;
  accessToken: string | null;
  onSessionExpired: () => void;
}

type LecturaVisto =
  | { status: 'loading' }
  | { status: 'ready'; visto: boolean }
  | { status: 'error'; expired: boolean };

/**
 * Control de «visto» del partido mostrado (WAT-179).
 *
 * Al montarse lee el estado persistido (WAT-197). Mientras lee, o si la
 * lectura falla, no ofrece ninguna acción: un estado desconocido nunca se
 * muestra como «no visto». Una vez leído, SOLO cambia con la respuesta
 * exitosa del servidor: mientras la petición está en curso la acción queda
 * deshabilitada, y un fallo conserva el último estado confirmado y deja
 * reintentar con el mismo botón.
 *
 * Se monta con `key` por partido y por usuario, así un cambio de cualquiera
 * de los dos arranca de cero; al desmontar se cancelan los pedidos y una
 * respuesta que igual llegue se descarta.
 */
function MarcarVisto({ matchId, accessToken, onSessionExpired }: MarcarVistoProps) {
  const [lectura, setLectura] = useState<LecturaVisto>({ status: 'loading' });
  const [intentoLectura, setIntentoLectura] = useState(0);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState<ErrorVisto | null>(null);
  const controller = useRef<AbortController | null>(null);
  // El token se renueva solo cada tanto: una renovación no vuelve a leer, por
  // eso la lectura toma el último token sin depender de él.
  const token = useRef(accessToken);

  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  // Si la pantalla se desmonta mientras espera, la respuesta se descarta.
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null) return;

    const lecturaController = new AbortController();

    getWatched(matchId, accessTokenActual, lecturaController.signal)
      .then((visto) => {
        if (!lecturaController.signal.aborted) setLectura({ status: 'ready', visto });
      })
      .catch((caught: unknown) => {
        if (lecturaController.signal.aborted || isWatchedCancelled(caught)) return;

        setLectura({
          status: 'error',
          expired: caught instanceof WatchedApiError && caught.kind === 'unauthorized',
        });
      });

    return () => lecturaController.abort();
  }, [matchId, intentoLectura]);

  const reintentarLectura = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntentoLectura((valor) => valor + 1);
  }, []);

  const visto = lectura.status === 'ready' ? lectura.visto : null;

  const alternar = useCallback(() => {
    if (accessToken === null || actualizando || visto === null) return;

    const abortController = new AbortController();
    controller.current = abortController;
    setActualizando(true);
    setError(null);

    setWatched(matchId, !visto, accessToken, abortController.signal)
      .then((confirmado) => {
        if (abortController.signal.aborted) return;

        setLectura({ status: 'ready', visto: confirmado });
        setActualizando(false);
      })
      .catch((caught: unknown) => {
        if (abortController.signal.aborted || isWatchedCancelled(caught)) return;

        setError(toErrorVisto(caught));
        setActualizando(false);
      });
  }, [accessToken, actualizando, matchId, visto]);

  if (lectura.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Consultando si ya viste este partido…
      </p>
    );
  }

  if (lectura.status === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">
          {lectura.expired ? 'La sesión venció. Iniciá sesión nuevamente.' : MENSAJE_LECTURA_VISTO}
        </p>

        {lectura.expired ? (
          <Button type="button" onClick={onSessionExpired}>
            Iniciar sesión nuevamente
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={reintentarLectura}>
            Reintentar
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={actualizando}
        aria-busy={actualizando}
        onClick={alternar}
      >
        {visto ? 'Deshacer visto' : 'Marcar como visto'}
      </Button>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">{error.message}</p>

          {error.expired ? (
            <Button type="button" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Detalle mínimo de un partido.
 *
 * El `matchId` de la URL se pasa al cliente sin interpretarlo: es opaco. Carga,
 * no encontrado, error recuperable y sesión vencida son estados distintos.
 *
 * Se remonta con `key` por cada `matchId`, igual que `RoomPage` (WAT-205): al
 * pasar de un partido a otro el estado arranca de nuevo en carga y nunca
 * quedan título, acciones, errores ni pedidos pendientes del anterior.
 */
export function MatchDetailPage() {
  const { matchId } = useParams<{ matchId: string }>();

  if (matchId === undefined) return null;

  return <DetallePartido key={matchId} matchId={matchId} />;
}

function DetallePartido({ matchId }: { matchId: string }) {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;
  const userId = session?.user.id ?? null;

  const navigate = useNavigate();

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  const [entrando, setEntrando] = useState(false);
  const [errorSala, setErrorSala] = useState<ErrorSala | null>(null);
  const salaController = useRef<AbortController | null>(null);

  // Al desmontar (salir o cambiar de partido) se cancela el pedido de la sala.
  useEffect(() => () => salaController.current?.abort(), []);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null) return;

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

  const entrarALaSala = useCallback(
    (partidoId: string) => {
      if (accessToken === null) return;

      const controller = new AbortController();
      salaController.current = controller;
      setEntrando(true);
      setErrorSala(null);

      // Se mira la señal además del error de cancelación: si el pedido ya se
      // abortó, una respuesta que igual llegue no navega a la sala de otro
      // partido ni toca el estado de una pantalla desmontada.
      enterRoom(partidoId, accessToken, controller.signal)
        .then((sala) => {
          if (controller.signal.aborted) return;

          navigate(`/rooms/${encodeURIComponent(sala.id)}`);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isRoomCancelled(error)) return;

          setErrorSala(toErrorSala(error));
          setEntrando(false);
        });
    },
    [accessToken, navigate],
  );

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
          <>
            <Card className="gap-2 p-4">
              <p className="text-sm text-muted-foreground">
                {formatKickoff(estado.match.kickoffAt)}
              </p>
              <p className="text-base font-semibold">{matchStatusLabel(estado.match.status)}</p>
            </Card>

            <Button
              type="button"
              className="self-start"
              disabled={entrando}
              aria-busy={entrando}
              onClick={() => entrarALaSala(estado.match.id)}
            >
              Entrar a la sala
            </Button>

            {errorSala ? (
              <div role="alert" className="flex flex-col items-start gap-3">
                <p className="text-sm text-destructive">{errorSala.message}</p>

                {errorSala.expired ? (
                  <Button type="button" onClick={() => void signOut()}>
                    Iniciar sesión nuevamente
                  </Button>
                ) : null}
              </div>
            ) : null}

            <MarcarVisto
              key={`${estado.match.id}:${userId}`}
              matchId={estado.match.id}
              accessToken={accessToken}
              onSessionExpired={() => void signOut()}
            />
          </>
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
