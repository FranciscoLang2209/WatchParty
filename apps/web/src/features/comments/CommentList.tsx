import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { listComments } from './api';
import { mergeComments } from './merge';
import { CommentsApiError, isCancelled, type RoomComment } from './types';

export interface CommentListProps {
  roomId: string;
  accessToken: string;
  /**
   * Comentarios nuevos, de a uno o varios: los que crea `CommentForm` y los
   * que llegan por Realtime. Se fusionan por `id` con la lista local sin
   * volver a pedirle nada al servidor, cada uno en su lugar cronológico.
   * Quien los acumula y conecta es la pantalla de sala.
   */
  newComments?: RoomComment[];
  /**
   * Cada vez que cambia, la lista se vuelve a pedir y se fusiona por `id` con
   * lo que ya está visible, sin anunciar carga. La pantalla de sala lo cambia
   * al recuperar la escucha en vivo, para traer lo que se perdió en la caída.
   */
  reloadSignal?: number;
  /**
   * Se dispara si un pedido falla por sesión vencida. `CommentList` no sabe
   * nada del flujo de Auth: quien lo monta decide qué hacer (típicamente,
   * pasarle el mismo `signOut` que ya usa para el resto de la pantalla).
   * Sin esta prop, el mensaje de error se muestra igual, pero sin botón de
   * acción — reintentar no serviría con un token vencido.
   */
  onSessionExpired?: () => void;
}

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; roomId: string; comments: RoomComment[] }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar los comentarios. Intentá de nuevo.';
const MENSAJE_VACIO = 'Todavía no hay comentarios. Sé el primero en comentar la jugada.';

function toEstadoError(error: unknown): Estado {
  if (error instanceof CommentsApiError) {
    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

function esSesionVencida(estado: Estado): boolean {
  return estado.status === 'error' && estado.expired;
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Lista de comentarios de una sala.
 *
 * Consulta `listComments` al montarse (y de nuevo si cambia `roomId` o
 * `accessToken`) y respeta el orden que ya viene del servidor — no
 * reordena. Si vuelve a pedirla con la lista de esa misma sala ya visible
 * (por `reloadSignal`), fusiona la respuesta con ella en vez de reemplazarla,
 * y un fallo de esa recarga no tapa lo que ya se ve. `newComments` es la puerta de entrada para lo que crea
 * `CommentForm` y lo que llega por Realtime: se fusionan por `id` con la
 * lista, así un mismo valor recibido dos veces no duplica nada y uno que
 * llega fuera de orden queda en su lugar cronológico.
 */
export function CommentList({
  roomId,
  accessToken,
  newComments = [],
  reloadSignal = 0,
  onSessionExpired,
}: CommentListProps) {
  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let vigente = true;

    listComments(roomId, accessToken, controller.signal)
      .then((comments) => {
        if (!vigente) return;

        setEstado((previo) => ({
          status: 'ready',
          roomId,
          comments:
            previo.status === 'ready' && previo.roomId === roomId
              ? mergeComments(previo.comments, comments)
              : comments,
        }));
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje o cambio de sala no se anuncia.
        if (!vigente || isCancelled(error)) return;

        const fallo = toEstadoError(error);

        // Una recarga fallida no tapa la lista ya visible, salvo que la sesión
        // haya vencido: ahí hace falta ofrecer el reingreso.
        setEstado((previo) =>
          previo.status === 'ready' && previo.roomId === roomId && !esSesionVencida(fallo)
            ? previo
            : fallo,
        );
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [roomId, accessToken, intento, reloadSignal]);

  const reintentar = useCallback(() => {
    setIntento((valor) => valor + 1);
    setEstado({ status: 'loading' });
  }, []);

  if (estado.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Cargando comentarios…
      </p>
    );
  }

  if (estado.status === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">{estado.message}</p>

        {estado.expired ? (
          onSessionExpired ? (
            <Button type="button" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : null
        ) : (
          <Button type="button" variant="outline" onClick={reintentar}>
            Reintentar
          </Button>
        )}
      </div>
    );
  }

  // Acá estado.status === 'ready'. Los nuevos se fusionan sin duplicar y en
  // orden cronológico: no se guardan, se calcula qué mostrar en cada render.
  const comentarios =
    newComments.length > 0 ? mergeComments(estado.comments, newComments) : estado.comments;

  if (comentarios.length === 0) {
    return <p className="text-sm text-muted-foreground">{MENSAJE_VACIO}</p>;
  }

  return (
    <ul className="flex w-full list-none flex-col gap-3">
      {comentarios.map((comment) => (
        <li
          key={comment.id}
          className="w-full min-w-0 rounded-md border border-border bg-card px-3 py-2"
        >
          <p className="text-sm break-words whitespace-pre-wrap">{comment.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatFecha(comment.createdAt)}</p>
        </li>
      ))}
    </ul>
  );
}
