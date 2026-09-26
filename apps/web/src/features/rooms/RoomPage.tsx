import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getRoom } from './api';
import { RoomsApiError, isCancelled, type PublicRoom } from './types';
import { CommentForm } from '@/features/comments/CommentForm';
import { CommentList } from '@/features/comments/CommentList';
import type { RoomComment } from '@/features/comments/types';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; room: PublicRoom }
  | { status: 'not-found' }
  | { status: 'error'; message: string; expired: boolean };

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
  const [nuevoComentario, setNuevoComentario] = useState<RoomComment | null>(null);

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

        {estado.status === 'ready' ? (
          <Card className="gap-2 p-4">
            <p className="text-sm text-muted-foreground">Identificador de sala</p>
            <p className="min-w-0 font-mono text-sm break-all">{estado.room.id}</p>
          </Card>
        ) : null}

        {estado.status === 'ready' && accessToken !== null ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Comentarios</h2>

            <CommentForm
              roomId={roomId}
              accessToken={accessToken}
              onCommentCreated={setNuevoComentario}
            />

            <CommentList
              roomId={roomId}
              accessToken={accessToken}
              newComment={nuevoComentario}
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
