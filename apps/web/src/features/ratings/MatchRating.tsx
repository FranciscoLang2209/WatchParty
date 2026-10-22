import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getRating, saveRating } from './api';
import { RATING_VALUES, RatingsApiError, isCancelled, type RatingValue } from './types';

interface MatchRatingProps {
  matchId: string;
  accessToken: string | null;
  onSessionExpired: () => void;
}

type Lectura =
  | { status: 'loading' }
  | { status: 'ready'; rating: RatingValue | null }
  | { status: 'error'; expired: boolean };

type ErrorGuardado = { message: string; expired: boolean };

const MENSAJE_LECTURA = 'No pudimos cargar tu calificación. Intentá de nuevo.';
const MENSAJE_SESION_VENCIDA = 'La sesión venció. Iniciá sesión nuevamente.';
const MENSAJE_INESPERADO_GUARDADO = 'No pudimos guardar tu calificación. Intentá de nuevo.';

function toErrorGuardado(error: unknown): ErrorGuardado {
  if (error instanceof RatingsApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO_GUARDADO, expired: false };
}

/**
 * Selector de la nota propia del partido mostrado (WAT-213): cinco botones, del
 * 1 al 5, que sólo se muestra para un partido finalizado y visto (lo decide el
 * detalle; este componente no lo asume).
 *
 * Al montarse lee la nota persistida (WAT-212). Mientras lee, o si la lectura
 * falla, no ofrece ninguna acción: un estado desconocido nunca se muestra como
 * «sin calificar». Una vez leída, la nota mostrada SOLO cambia con la respuesta
 * exitosa del servidor: mientras se guarda no se aceptan más envíos, y un fallo
 * conserva la última nota confirmada y deja reintentar con los mismos botones.
 *
 * Se monta con `key` por partido y por usuario, así un cambio de cualquiera de
 * los dos arranca de cero; al desmontar se cancelan los pedidos y una respuesta
 * que igual llegue se descarta.
 *
 * Accesibilidad: es un grupo de botones con `aria-pressed` (no un radio group),
 * porque elegir guarda: con radios, recorrer las opciones con las flechas
 * dispararía un guardado por cada una. Durante el guardado usa `aria-disabled`
 * en vez de `disabled` para no sacarle el foco a quien navega con teclado.
 */
export function MatchRating({ matchId, accessToken, onSessionExpired }: MatchRatingProps) {
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intentoLectura, setIntentoLectura] = useState(0);
  const [guardando, setGuardando] = useState<RatingValue | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [error, setError] = useState<ErrorGuardado | null>(null);
  const controller = useRef<AbortController | null>(null);
  // El token se renueva solo cada tanto: una renovación no vuelve a leer, por
  // eso la lectura y el guardado toman el último token sin depender de él.
  const token = useRef(accessToken);
  const tituloId = useId();

  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  // Si la pantalla se desmonta mientras espera, la respuesta se descarta.
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null) return;

    const lecturaController = new AbortController();

    getRating(matchId, accessTokenActual, lecturaController.signal)
      .then((rating) => {
        if (!lecturaController.signal.aborted) setLectura({ status: 'ready', rating });
      })
      .catch((caught: unknown) => {
        if (lecturaController.signal.aborted || isCancelled(caught)) return;

        setLectura({
          status: 'error',
          expired: caught instanceof RatingsApiError && caught.kind === 'unauthorized',
        });
      });

    return () => lecturaController.abort();
  }, [matchId, intentoLectura]);

  const reintentarLectura = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntentoLectura((valor) => valor + 1);
  }, []);

  const confirmada = lectura.status === 'ready' ? lectura.rating : null;

  const elegir = useCallback(
    (nueva: RatingValue) => {
      const accessTokenActual = token.current;

      // Sin lectura confirmada, con un guardado en curso, o sin cambio real, no
      // se envía nada: evita duplicados y pedidos que no modifican la nota.
      if (
        accessTokenActual === null ||
        lectura.status !== 'ready' ||
        guardando !== null ||
        nueva === lectura.rating
      ) {
        return;
      }

      const abortController = new AbortController();
      controller.current = abortController;
      setGuardando(nueva);
      setGuardado(false);
      setError(null);

      saveRating(matchId, nueva, accessTokenActual, abortController.signal)
        .then((confirmado) => {
          if (abortController.signal.aborted) return;

          // Se muestra lo que confirma el servidor, no lo que se pidió.
          setLectura({ status: 'ready', rating: confirmado });
          setGuardando(null);
          setGuardado(true);
        })
        .catch((caught: unknown) => {
          if (abortController.signal.aborted || isCancelled(caught)) return;

          setError(toErrorGuardado(caught));
          setGuardando(null);
        });
    },
    [guardando, lectura, matchId],
  );

  if (lectura.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Consultando tu calificación…
      </p>
    );
  }

  if (lectura.status === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">
          {lectura.expired ? MENSAJE_SESION_VENCIDA : MENSAJE_LECTURA}
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

  const estado =
    guardando !== null
      ? 'Guardando tu calificación…'
      : guardado && confirmada !== null
        ? `Calificación guardada: ${confirmada} de 5.`
        : confirmada !== null
          ? `Tu calificación: ${confirmada} de 5.`
          : 'Todavía no calificaste este partido.';

  return (
    <div className="flex flex-col gap-3">
      <h2 id={tituloId} className="text-base font-semibold">
        Calificá el partido
      </h2>

      <div
        role="group"
        aria-labelledby={tituloId}
        aria-busy={guardando !== null}
        className="flex flex-wrap gap-2"
      >
        {RATING_VALUES.map((valor) => (
          <Button
            key={valor}
            type="button"
            size="icon"
            variant={confirmada === valor ? 'default' : 'outline'}
            aria-label={`${valor} de 5`}
            aria-pressed={confirmada === valor}
            aria-disabled={guardando !== null}
            onClick={() => elegir(valor)}
          >
            {valor}
          </Button>
        ))}
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {estado}
      </p>

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
    </div>
  );
}
