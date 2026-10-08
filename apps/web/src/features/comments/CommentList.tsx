import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { listComments, listCommentsPage } from './api';
import { mergeComments } from './merge';
import { CommentsApiError, isCancelled, type CommentsCursor, type RoomComment } from './types';

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
   * Cada vez que cambia, se pide la lista completa y se fusiona por `id` con
   * lo que ya está visible, sin anunciar carga. La pantalla de sala lo cambia
   * al recuperar la escucha en vivo, para traer lo que se perdió en la caída.
   * Con la lista ya recuperada entera no queda nada por paginar.
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
  | {
      status: 'ready';
      roomId: string;
      comments: RoomComment[];
      /** Desde dónde sigue la página siguiente; `null` si no quedan más. */
      nextCursor: CommentsCursor | null;
      /** Estado del pedido de «Cargar más comentarios». */
      more: 'idle' | 'loading' | 'error';
    }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar los comentarios. Intentá de nuevo.';
const MENSAJE_MAS = 'No pudimos cargar más comentarios. Intentá de nuevo.';
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
 * Pide la primera página al montarse (y de nuevo si cambia `roomId` o
 * `accessToken`) y respeta el orden que ya viene del servidor — no
 * reordena. Mientras el servidor informe un cursor ofrece «Cargar más
 * comentarios», que trae la página siguiente y la fusiona por `id`. Si vuelve
 * a pedir con la lista de esa misma sala ya visible, fusiona la respuesta con
 * ella en vez de reemplazarla, y un fallo de esa recarga no tapa lo que ya se
 * ve. Por `reloadSignal` pide la lista completa: recuperada entera, ya no
 * pagina. `newComments` es la puerta de entrada para lo que crea
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
  // Hay un pedido de página en curso: bloquea un segundo clic aunque todavía
  // no se haya vuelto a renderizar.
  const cargandoMas = useRef(false);
  const pedidoDeMas = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let vigente = true;
    // Tras una reconexión se recupera la lista completa (WAT-171), no una página.
    const completa = reloadSignal !== 0;

    const pedido = completa
      ? listComments(roomId, accessToken, controller.signal).then((comments) => ({
          comments,
          nextCursor: null,
        }))
      : listCommentsPage(roomId, accessToken, { signal: controller.signal });

    pedido
      .then((page) => {
        if (!vigente) return;

        setEstado((previo) => {
          const mismaSala = previo.status === 'ready' && previo.roomId === roomId;

          return {
            status: 'ready',
            roomId,
            comments: mismaSala ? mergeComments(previo.comments, page.comments) : page.comments,
            // Volver a pedir la primera página (p. ej. al renovarse el token) no
            // retrocede el cursor de quien ya había cargado más.
            nextCursor: completa ? null : mismaSala ? previo.nextCursor : page.nextCursor,
            more: mismaSala && !completa ? previo.more : 'idle',
          };
        });
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

  // Al salir, cambiar de sala o renovarse el token se cancela la página que
  // estuviera en camino: su respuesta (p. ej. un 401 del token viejo) ya no
  // vale. La acción queda libre para volver a pedirla con el token nuevo.
  useEffect(
    () => () => {
      if (!pedidoDeMas.current) return;

      pedidoDeMas.current.abort();
      pedidoDeMas.current = null;
      cargandoMas.current = false;
      setEstado((previo) =>
        previo.status === 'ready' && previo.more === 'loading'
          ? { ...previo, more: 'idle' }
          : previo,
      );
    },
    [roomId, accessToken],
  );

  const reintentar = useCallback(() => {
    setIntento((valor) => valor + 1);
    setEstado({ status: 'loading' });
  }, []);

  const cargarMas = useCallback(() => {
    if (estado.status !== 'ready' || estado.nextCursor === null || cargandoMas.current) return;

    const cursor = estado.nextCursor;
    const sala = estado.roomId;
    const controller = new AbortController();

    cargandoMas.current = true;
    pedidoDeMas.current = controller;
    setEstado((previo) =>
      previo.status === 'ready' && previo.nextCursor === cursor
        ? { ...previo, more: 'loading' }
        : previo,
    );

    listCommentsPage(sala, accessToken, { cursor, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;

        setEstado((previo) => {
          if (previo.status !== 'ready' || previo.roomId !== sala) return previo;

          const comments = mergeComments(previo.comments, page.comments);

          // Si el cursor cambió mientras tanto (la reconexión ya trajo todo),
          // la página sólo aporta comentarios: no reabre la paginación.
          return previo.nextCursor === cursor
            ? { ...previo, comments, nextCursor: page.nextCursor, more: 'idle' }
            : { ...previo, comments };
        });
      })
      .catch((error: unknown) => {
        // Un pedido cancelado no se anuncia, aunque su error haya llegado
        // después de cancelarlo.
        if (controller.signal.aborted || isCancelled(error)) return;

        const fallo = toEstadoError(error);

        // El fallo conserva los comentarios y el cursor para reintentar, salvo
        // que la sesión haya vencido: ahí hace falta ofrecer el reingreso.
        setEstado((previo) => {
          if (previo.status !== 'ready' || previo.roomId !== sala) return previo;
          if (esSesionVencida(fallo)) return fallo;

          return previo.nextCursor === cursor ? { ...previo, more: 'error' } : previo;
        });
      })
      .finally(() => {
        if (pedidoDeMas.current !== controller) return;

        pedidoDeMas.current = null;
        cargandoMas.current = false;
      });
  }, [estado, accessToken]);

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
    <div className="flex w-full flex-col gap-3">
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

      {estado.nextCursor !== null ? (
        <div className="flex flex-col items-start gap-3">
          {estado.more === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {MENSAJE_MAS}
            </p>
          ) : null}

          {/* El mismo botón reintenta tras un fallo. `aria-disabled` y no
              `disabled`: no pierde el foco mientras llega la página. */}
          <Button
            type="button"
            variant="outline"
            aria-disabled={estado.more === 'loading'}
            aria-busy={estado.more === 'loading'}
            onClick={cargarMas}
          >
            {estado.more === 'loading' ? 'Cargando comentarios…' : 'Cargar más comentarios'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
