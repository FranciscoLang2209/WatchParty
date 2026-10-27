import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getRatingSummary } from './api';
import { formatAverage, formatVotes } from './format';
import { RatingsApiError, isCancelled, type RatingSummary } from './types';

interface MatchRatingSummaryProps {
  matchId: string;
  accessToken: string | null;
  onSessionExpired: () => void;
  /**
   * Cambia cada vez que la persona guarda o edita SU nota (WAT-213): al
   * cambiar, el resumen se vuelve a pedir, porque su voto pudo mover el
   * promedio o la cantidad. No lleva ningún dato: el valor sale del servidor.
   */
  refreshKey: number;
}

/**
 * Lo último que respondió el servidor y para qué `refreshKey` lo pidió. Un
 * resultado de un `refreshKey` anterior ya no está vigente: mientras llega el
 * nuevo se muestra la carga, nunca el valor viejo.
 */
type Lectura =
  | { status: 'loading' }
  | { status: 'ready'; summary: RatingSummary; refreshKey: number }
  | { status: 'error'; expired: boolean; refreshKey: number };

const MENSAJE_LECTURA = 'No pudimos cargar el promedio de calificaciones. Intentá de nuevo.';
const MENSAJE_SESION_VENCIDA = 'La sesión venció. Iniciá sesión nuevamente.';

/**
 * Promedio y cantidad de votos del partido (WAT-215), con los datos del
 * servidor (WAT-214). Sólo hay cuatro estados y ninguno se confunde con otro:
 * cargando, sin calificaciones (el servidor confirmó cero votos), con
 * calificaciones, o error. Un fallo NUNCA se muestra como «cero votos» ni como
 * un promedio viejo: o se ve lo que confirmó el servidor, o se avisa el error.
 *
 * Se monta con `key` por partido. Al cambiar `refreshKey` (la persona guardó su
 * nota) el resumen anterior deja de ser vigente: mientras se vuelve a pedir se
 * muestra la carga, y recién llega el valor nuevo o el error. Así nunca
 * conviven en pantalla una nota recién guardada y un resumen que no la incluye.
 * Una respuesta que llegue tarde (de un pedido reemplazado o de una pantalla
 * desmontada) se descarta.
 */
export function MatchRatingSummary({
  matchId,
  accessToken,
  onSessionExpired,
  refreshKey,
}: MatchRatingSummaryProps) {
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  // El token se renueva solo cada tanto: una renovación no vuelve a pedir.
  const token = useRef(accessToken);
  const tituloId = useId();

  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null) return;

    const controller = new AbortController();

    getRatingSummary(matchId, accessTokenActual, controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) setLectura({ status: 'ready', summary, refreshKey });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isCancelled(caught)) return;

        setLectura({
          status: 'error',
          expired: caught instanceof RatingsApiError && caught.kind === 'unauthorized',
          refreshKey,
        });
      });

    return () => controller.abort();
  }, [matchId, refreshKey, intento]);

  // Un resultado de un `refreshKey` anterior es viejo: se trata como carga.
  const visible: Lectura =
    lectura.status !== 'loading' && lectura.refreshKey !== refreshKey
      ? { status: 'loading' }
      : lectura;

  const reintentar = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  return (
    <section aria-labelledby={tituloId} className="flex flex-col gap-2">
      <h2 id={tituloId} className="text-base font-semibold">
        Calificación de la comunidad
      </h2>

      {visible.status === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Consultando las calificaciones…
        </p>
      ) : null}

      {visible.status === 'error' ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">
            {visible.expired ? MENSAJE_SESION_VENCIDA : MENSAJE_LECTURA}
          </p>

          {visible.expired ? (
            <Button type="button" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={reintentar}>
              Reintentar
            </Button>
          )}
        </div>
      ) : null}

      {visible.status === 'ready' && visible.summary.average === null ? (
        <p className="text-sm text-muted-foreground">
          Todavía no hay calificaciones para este partido.
        </p>
      ) : null}

      {visible.status === 'ready' && visible.summary.average !== null ? (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-semibold">{formatAverage(visible.summary.average)}</span>
          <span className="text-sm text-muted-foreground">
            de 5 ({formatVotes(visible.summary.count)})
          </span>
        </p>
      ) : null}
    </section>
  );
}
