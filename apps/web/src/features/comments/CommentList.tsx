import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { listComments } from './api';
import { CommentsApiError, isCancelled, type RoomComment } from './types';

export interface CommentListProps {
  roomId: string;
  accessToken: string;
  /**
   * El comentario recién creado por `CommentForm`, si lo hay. Cuando cambia
   * (por `id`), se suma a la lista local sin volver a pedirle nada al
   * servidor. Quien conecta ambos componentes es la futura pantalla de sala
   * (WAT-146) — acá sólo se deja el contrato listo.
   */
  newComment?: RoomComment | null;
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
  | { status: 'ready'; comments: RoomComment[] }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar los comentarios. Intentá de nuevo.';
const MENSAJE_VACIO = 'Todavía no hay comentarios. Sé el primero en comentar la jugada.';

function toEstadoError(error: unknown): Estado {
  if (error instanceof CommentsApiError) {
    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
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
 * reordena. `newComment` es la puerta de entrada para el comentario que crea
 * `CommentForm`: se agrega al final sólo si su `id` todavía no está en la
 * lista, así un mismo valor recibido dos veces no duplica nada.
 */
export function CommentList({
  roomId,
  accessToken,
  newComment = null,
  onSessionExpired,
}: CommentListProps) {
  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let vigente = true;

    listComments(roomId, accessToken, controller.signal)
      .then((comments) => {
        if (vigente) setEstado({ status: 'ready', comments });
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje o cambio de sala no se anuncia.
        if (!vigente || isCancelled(error)) return;

        setEstado(toEstadoError(error));
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [roomId, accessToken, intento]);

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

  // Acá estado.status === 'ready'. `newComment` se superpone sin duplicar:
  // no se guarda, se calcula qué mostrar en cada render.
  const comentarios =
    newComment !== null && !estado.comments.some((comment) => comment.id === newComment.id)
      ? [...estado.comments, newComment]
      : estado.comments;

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
