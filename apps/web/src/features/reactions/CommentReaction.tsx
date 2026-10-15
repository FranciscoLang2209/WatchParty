import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getReaction, setReaction } from './api';
import { ReactionsApiError, isCancelled, type ReactionState } from './types';

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

/**
 * Cada cuánto se vuelve a leer la reacción para ver las de otras personas. Se
 * le suma un ±20 % de variación para que los comentarios de una sala no pidan
 * todos en el mismo instante.
 */
export const REACTION_REFRESH_MS = 10_000;

function esSesionVencida(error: unknown): boolean {
  return error instanceof ReactionsApiError && error.kind === 'unauthorized';
}

function descripcionConteo(count: number): string {
  return count === 1 ? '1 reacción' : `${count} reacciones`;
}

/**
 * «Me gusta» de un comentario mostrado (WAT-208), como ícono con contador.
 *
 * Al montarse lee el estado persistido (WAT-206). Mientras lee, o si la
 * lectura falla, no ofrece ninguna acción: un estado desconocido nunca se
 * muestra como «0» ni como «sin reaccionar». Una vez leído, SOLO cambia con la
 * respuesta confirmada del servidor: durante el pedido la acción ignora nuevos
 * clics, y un fallo conserva el último estado confirmado y deja reintentar con
 * el mismo botón.
 *
 * Las reacciones de otras personas se ven sin recargar: mientras la pestaña
 * está visible se vuelve a leer cada `REACTION_REFRESH_MS` y al volver a ella.
 * Esa lectura nunca pisa un estado más nuevo: se ignora si hay una acción en
 * curso o si empezó una después de pedirla, y un fallo se descarta sin avisar
 * (queda el último estado confirmado; el aviso es de las acciones de la
 * persona). No hay Realtime de reacciones: la tabla es privada del backend.
 *
 * El nombre accesible cambia con el estado («Me gusta» / «Quitar me gusta») y
 * el contador va como descripción. El estado también se distingue por la forma
 * del ícono (relleno o no), no solo por el color.
 *
 * Se monta con `key` por comentario y por usuario, así un cambio de cualquiera
 * de los dos arranca de cero; al desmontar se cancelan los pedidos y una
 * respuesta que igual llegue se descarta.
 */
export function CommentReaction({
  roomId,
  commentId,
  accessToken,
  onSessionExpired,
}: CommentReactionProps) {
  const descripcionId = useId();
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intentoLectura, setIntentoLectura] = useState(0);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState<ErrorMutacion | null>(null);
  // Resultado de la última acción propia, para lectores de pantalla.
  const [anuncio, setAnuncio] = useState('');
  // Bloquea un segundo clic aunque todavía no se haya vuelto a renderizar.
  const enCurso = useRef(false);
  const mutacion = useRef<AbortController | null>(null);
  // Lectura periódica en camino: empezar una acción propia la cancela, así una
  // respuesta con un estado viejo nunca pisa el que la acción confirma.
  const lecturaPeriodica = useRef<AbortController | null>(null);
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

  const listo = lectura.status === 'ready';

  // Reacciones de otras personas: lectura periódica silenciosa.
  const refrescar = useCallback(() => {
    if (enCurso.current || document.visibilityState === 'hidden') return;

    lecturaPeriodica.current?.abort();

    const controller = new AbortController();

    lecturaPeriodica.current = controller;

    getReaction(roomId, commentId, token.current, controller.signal)
      .then((reaction) => {
        if (controller.signal.aborted || enCurso.current) return;

        setLectura((previo) =>
          previo.status === 'ready' &&
          previo.reaction.count === reaction.count &&
          previo.reaction.reacted === reaction.reacted
            ? previo
            : { status: 'ready', reaction },
        );
      })
      .catch(() => {
        // Sin aviso: se conserva el último estado confirmado.
      });
  }, [roomId, commentId]);

  useEffect(() => {
    if (!listo) return;

    let temporizador: ReturnType<typeof setTimeout>;

    const programar = () => {
      temporizador = setTimeout(
        () => {
          refrescar();
          programar();
        },
        REACTION_REFRESH_MS * (0.8 + Math.random() * 0.4),
      );
    };
    const alVolver = () => {
      if (document.visibilityState === 'visible') refrescar();
    };

    programar();
    document.addEventListener('visibilitychange', alVolver);

    return () => {
      clearTimeout(temporizador);
      document.removeEventListener('visibilitychange', alVolver);
      lecturaPeriodica.current?.abort();
      lecturaPeriodica.current = null;
    };
  }, [listo, refrescar]);

  const actual = lectura.status === 'ready' ? lectura.reaction : null;

  const alternar = useCallback(() => {
    if (enCurso.current || actual === null) return;

    const controller = new AbortController();
    mutacion.current = controller;
    enCurso.current = true;
    lecturaPeriodica.current?.abort();
    setActualizando(true);
    setError(null);
    setAnuncio('');

    setReaction(roomId, commentId, !actual.reacted, token.current, controller.signal)
      .then((confirmada) => {
        if (controller.signal.aborted) return;

        setLectura({ status: 'ready', reaction: confirmada });
        setAnuncio(confirmada.reacted ? 'Me gusta agregado.' : 'Me gusta quitado.');
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
      <span aria-busy="true" className="ml-auto text-xs text-muted-foreground">
        Cargando reacción…
      </span>
    );
  }

  if (lectura.status === 'error') {
    return (
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <p role="alert" className="text-xs text-destructive">
          {lectura.expired ? MENSAJE_SESION : MENSAJE_LECTURA}
        </p>

        {lectura.expired ? (
          <Button type="button" size="sm" onClick={onSessionExpired}>
            Iniciar sesión nuevamente
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={reintentarLectura}>
            Reintentar
          </Button>
        )}
      </div>
    );
  }

  const { reacted, count } = lectura.reaction;

  return (
    <>
      {/* `aria-disabled` y no `disabled`: el botón no pierde el foco mientras
          llega la respuesta, y el teclado sigue en el mismo lugar. El ícono
          pasa de contorno a relleno al reaccionar, así que el estado no depende
          solo del color. */}
      <Button
        type="button"
        size="sm"
        className="ml-auto min-h-11 min-w-11 gap-1.5 px-3"
        variant={reacted ? 'default' : 'outline'}
        aria-label={reacted ? 'Quitar me gusta' : 'Me gusta'}
        aria-describedby={descripcionId}
        aria-disabled={actualizando}
        aria-busy={actualizando}
        onClick={alternar}
      >
        <ThumbsUp aria-hidden="true" className={reacted ? 'fill-current' : undefined} />
        <span aria-hidden="true" className="tabular-nums">
          {count}
        </span>
      </Button>

      <span id={descripcionId} className="sr-only">
        {descripcionConteo(count)}
      </span>

      <span role="status" className="sr-only">
        {anuncio}
      </span>

      {error ? (
        <div role="alert" className="flex w-full flex-col items-end gap-2 text-right">
          <p className="text-xs text-destructive">{error.message}</p>

          {error.expired ? (
            <Button type="button" size="sm" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
