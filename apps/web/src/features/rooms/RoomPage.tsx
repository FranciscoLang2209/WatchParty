import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { getRoom } from './api';
import { RoomMatchHeader } from './RoomMatchHeader';
import { RoomsApiError, isCancelled, type PublicRoom } from './types';
import { CommentForm } from '@/features/comments/CommentForm';
import { CommentList } from '@/features/comments/CommentList';
import type { RoomComment } from '@/features/comments/types';
import { subscribeToRoomComments, type RoomCommentsStatus } from '@/features/comments/realtime';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; room: PublicRoom }
  | { status: 'not-found' }
  | { status: 'error'; message: string; expired: boolean };

/**
 * Estado de la escucha en vivo visto desde la pantalla. A los dos que publica
 * la suscripción se suman los de espera: `connecting` (todavía no respondió,
 * no es una caída) y `reconnecting` (reintento pedido y sin respuesta).
 */
type Conexion = RoomCommentsStatus | 'connecting' | 'reconnecting';

const MENSAJE_INESPERADO = 'No pudimos abrir la sala. Intentá de nuevo.';

function toEstadoError(error: unknown): Estado {
  if (error instanceof RoomsApiError) {
    // Una sala inexistente es una respuesta legítima, no un fallo recuperable.
    if (error.kind === 'not-found') return { status: 'not-found' };

    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Sala pública de un partido en `/rooms/:roomId`.
 *
 * Se remonta con `key` por cada `roomId`: al pasar de una sala a otra el
 * estado arranca de nuevo en carga y nunca quedan datos de la anterior.
 */
export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();

  if (roomId === undefined) return null;

  return <Sala key={roomId} roomId={roomId} />;
}

function Sala({ roomId }: { roomId: string }) {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  const [nuevosComentarios, setNuevosComentarios] = useState<RoomComment[]>([]);
  const [conexion, setConexion] = useState<Conexion>('connecting');
  const [intentoDeSuscripcion, setIntentoDeSuscripcion] = useState(0);
  const [reconexiones, setReconexiones] = useState(0);
  // Hubo una caída desde la última vez que la escucha estuvo operativa: los
  // comentarios de ese intervalo no llegaron por el canal.
  const huboCaida = useRef(false);

  // Un mismo comentario puede llegar dos veces (el form y el canal en vivo):
  // se acumula por `id` con una actualización funcional, así varios eventos
  // seguidos no se pisan entre sí.
  const agregarComentario = useCallback((comentario: RoomComment) => {
    setNuevosComentarios((actuales) =>
      actuales.some((actual) => actual.id === comentario.id) ? actuales : [...actuales, comentario],
    );
  }, []);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null) return;

    const controller = new AbortController();
    let vigente = true;

    getRoom(roomId, accessToken, controller.signal)
      .then((room) => {
        if (vigente) setEstado({ status: 'ready', room });
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
  }, [roomId, accessToken, intento]);

  // La escucha en vivo sólo existe con la sala lista y se cancela al salir o
  // al pasar a otra sala (Realtime, docs/decisions/realtime-comments.md).
  useEffect(() => {
    if (estado.status !== 'ready') return;

    // Una suscripción reemplazada o cancelada ya no opina sobre la conexión.
    let vigente = true;
    const cancelar = subscribeToRoomComments(roomId, agregarComentario, {
      onStatusChange: (status) => {
        if (!vigente) return;

        setConexion(status);

        if (status === 'disconnected') {
          huboCaida.current = true;
        } else if (huboCaida.current) {
          // Volvió la conexión: se recarga la lista para recuperar lo perdido.
          huboCaida.current = false;
          setReconexiones((valor) => valor + 1);
        }
      },
    });

    return () => {
      vigente = false;
      cancelar();
    };
  }, [roomId, estado.status, agregarComentario, intentoDeSuscripcion]);

  // Reinicia sólo la suscripción: la sala, la lista y el borrador no se tocan.
  const reconectar = useCallback(() => {
    if (conexion !== 'disconnected') return;

    setConexion('reconnecting');
    setIntentoDeSuscripcion((valor) => valor + 1);
  }, [conexion]);

  const reintentar = useCallback(() => {
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
        <h1 className="min-w-0 text-2xl leading-tight font-semibold break-words sm:text-3xl">
          Sala del partido
        </h1>

        {estado.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando la sala…
          </p>
        ) : null}

        {estado.status === 'ready' && accessToken !== null ? (
          <RoomMatchHeader matchId={estado.room.matchId} accessToken={accessToken} />
        ) : null}

        {estado.status === 'ready' && accessToken !== null ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Comentarios</h2>

            {conexion === 'disconnected' || conexion === 'reconnecting' ? (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2"
              >
                <p className="min-w-0 text-sm">Los comentarios no se están actualizando en vivo.</p>

                {/* `aria-disabled` y no `disabled`: el botón no pierde el foco mientras reconecta. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={conexion === 'reconnecting'}
                  onClick={reconectar}
                >
                  Reintentar
                </Button>
              </div>
            ) : null}

            <CommentForm
              roomId={roomId}
              accessToken={accessToken}
              onCommentCreated={agregarComentario}
            />

            <CommentList
              roomId={roomId}
              accessToken={accessToken}
              newComments={nuevosComentarios}
              reloadSignal={reconexiones}
              onSessionExpired={() => void signOut()}
            />
          </div>
        ) : null}

        {estado.status === 'not-found' ? (
          <p role="status" className="text-sm text-muted-foreground">
            No encontramos esa sala.
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
      </div>
    </section>
  );
}
