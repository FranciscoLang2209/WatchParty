import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getReaction, setReaction } from '@/features/reactions/api';
import { ReactionsApiError, isCancelled, type ReactionState } from '@/features/reactions/types';

export interface CommentReactionProps {
  roomId: string;
  commentId: string;
  accessToken: string;
  /** Sesión vencida: quien monta decide qué hacer (típicamente `signOut`). */
  onSessionExpired: () => void;
}

type Lectura =
  | { status: 'loading' }
  | { status: 'ready'; reaction: ReactionState }
  | { status: 'error'; expired: boolean };

type ErrorMutacion = { message: string; expired: boolean };

const MENSAJE_LECTURA = 'No pudimos cargar las reacciones. Intentá de nuevo.';
const MENSAJE_INESPERADO = 'No pudimos actualizar la reacción. Intentá de nuevo.';
const MENSAJE_SESION = 'La sesión venció. Iniciá sesión nuevamente.';

function esSesionVencida(error: unknown): boolean {
  return error instanceof ReactionsApiError && error.kind === 'unauthorized';
}

/**
 * «Me gusta» de un comentario mostrado (WAT-208).
 *
 * Al montarse lee el estado persistido (WAT-206). Mientras lee, o si la
 * lectura falla, no ofrece ninguna acción: un estado desconocido nunca se
 * muestra como «0» ni como «sin reaccionar». Una vez leído, SOLO cambia con la
 * respuesta confirmada del servidor: durante el pedido la acción ignora nuevos
 * clics, y un fallo conserva el último estado confirmado y deja reintentar con
 * el mismo botón.
 *
 * Se monta con `key` por comentario y por usuario, así un cambio de cualquiera
 * de los dos arranca de cero; al desmontar se cancelan los pedidos y una
 * respuesta que igual llegue se descarta.
 *
 * Límite: no hay Realtime de reacciones. Las de otras personas se ven al
 * recargar.
 */
export function CommentReaction({
  roomId,
  commentId,
  accessToken,
  onSessionExpired,
}: CommentReactionProps) {
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intentoLectura, setIntentoLectura] = useState(0);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState<ErrorMutacion | null>(null);
  // Bloquea un segundo clic aunque todavía no se haya vuelto a renderizar.
  const enCurso = useRef(false);
  const mutacion = useRef<AbortController | null>(null);
  // El token se renueva solo cada tanto: una renovación no vuelve a leer, por
  // eso los pedidos toman el último token sin depender de él.
  const token = useRef(accessToken);

  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  // Si el comentario se desmonta mientras espera, la respuesta se descarta.
  useEffect(() => () => mutacion.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();

    getReaction(roomId, commentId, token.current, controller.signal)
      .then((reaction) => {
        if (!controller.signal.aborted) setLectura({ status: 'ready', reaction });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isCancelled(caught)) return;

        setLectura({ status: 'error', expired: esSesionVencida(caught) });
      });

    return () => controller.abort();
  }, [roomId, commentId, intentoLectura]);

  const reintentarLectura = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntentoLectura((valor) => valor + 1);
  }, []);

  const actual = lectura.status === 'ready' ? lectura.reaction : null;

  const alternar = useCallback(() => {
    if (enCurso.current || actual === null) return;

    const controller = new AbortController();
    mutacion.current = controller;
    enCurso.current = true;
    setActualizando(true);
    setError(null);

    setReaction(roomId, commentId, !actual.reacted, token.current, controller.signal)
      .then((confirmada) => {
        if (controller.signal.aborted) return;

        setLectura({ status: 'ready', reaction: confirmada });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isCancelled(caught)) return;

        setError({
          message: caught instanceof ReactionsApiError ? caught.message : MENSAJE_INESPERADO,
          expired: esSesionVencida(caught),
        });
      })
      .finally(() => {
        if (controller.signal.aborted || mutacion.current !== controller) return;

        mutacion.current = null;
        enCurso.current = false;
        setActualizando(false);
      });
  }, [actual, roomId, commentId]);

  if (lectura.status === 'loading') {
    return (
      <span aria-busy="true" className="text-xs text-muted-foreground">
        Cargando reacción…
      </span>
    );
  }

  if (lectura.status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-destructive">
          {lectura.expired ? MENSAJE_SESION : MENSAJE_LECTURA}
        </p>

        {lectura.expired ? (
          <Button type="button" size="sm" onClick={onSessionExpired}>
            Iniciar sesión nuevamente
          </Button>
        ) : (
          // Nombre propio: en una lista habría un «Reintentar» por comentario y,
          // sin esto, serían indistinguibles entre sí y del aviso de conexión.
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Reintentar cargar las reacciones"
            onClick={reintentarLectura}
          >
            Reintentar
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {/* `aria-disabled` y no `disabled`: el botón no pierde el foco mientras
          llega la respuesta, y el teclado sigue en el mismo lugar. */}
      <Button
        type="button"
        size="sm"
        className="min-h-11"
        variant={lectura.reaction.reacted ? 'default' : 'outline'}
        aria-pressed={lectura.reaction.reacted}
        aria-disabled={actualizando}
        aria-busy={actualizando}
        onClick={alternar}
      >
        Me gusta · {lectura.reaction.count}
      </Button>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-xs text-destructive">{error.message}</p>

          {error.expired ? (
            <Button type="button" size="sm" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
