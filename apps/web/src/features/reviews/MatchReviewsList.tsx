import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { listMatchReviews } from './api';
import { formatReviewDate } from './format';
import { ReviewsApiError, isCancelled, isRecoverable, type PublicReview } from './types';

interface MatchReviewsListProps {
  matchId: string;
  accessToken: string | null;
  onSessionExpired: () => void;
  /**
   * Cambia cada vez que la persona publica, edita o elimina SU reseña y el
   * servidor lo confirma (WAT-258). Al cambiar, el listado se vuelve a pedir
   * desde la primera página. No lleva ningún dato: todo sale del servidor.
   */
  refreshKey: number;
}

interface ErrorLectura {
  message: string;
  expired: boolean;
  recoverable: boolean;
}

/** Qué pasa con la página que sigue, sin tocar lo ya cargado. */
type Siguiente = { status: 'idle' } | { status: 'loading' } | ({ status: 'error' } & ErrorLectura);

/**
 * Lo último que respondió el servidor y para qué `refreshKey` lo pidió. Un
 * resultado de un `refreshKey` anterior ya no está vigente: mientras llega el
 * nuevo se muestra la carga, nunca la lista vieja.
 */
type Lectura =
  | { status: 'loading' }
  | ({ status: 'error'; refreshKey: number } & ErrorLectura)
  | {
      status: 'ready';
      refreshKey: number;
      items: PublicReview[];
      nextCursor: string | null;
      siguiente: Siguiente;
    };

const MENSAJE_LECTURA = 'No pudimos cargar las opiniones. Intentá de nuevo.';

/**
 * La API no entrega un identificador por opinión (sólo autor, texto y fecha):
 * la identidad se arma con esos tres campos.
 */
function claveDe({ authorName, body, createdAt }: PublicReview): string {
  return `${createdAt}\u0000${authorName}\u0000${body}`;
}

/** Suma `nuevas` a `actuales` sin repetir ninguna, conservando el orden. */
function unir(actuales: PublicReview[], nuevas: PublicReview[]): PublicReview[] {
  const vistas = new Set(actuales.map(claveDe));
  const resultado = [...actuales];

  for (const review of nuevas) {
    const clave = claveDe(review);

    if (vistas.has(clave)) continue;

    vistas.add(clave);
    resultado.push(review);
  }

  return resultado;
}

function toErrorLectura(error: unknown): ErrorLectura {
  if (error instanceof ReviewsApiError) {
    return {
      message: error.message || MENSAJE_LECTURA,
      expired: error.kind === 'unauthorized',
      recoverable: isRecoverable(error),
    };
  }

  return { message: MENSAJE_LECTURA, expired: false, recoverable: true };
}

function ErrorConAccion({
  error,
  onRetry,
  onSessionExpired,
}: {
  error: ErrorLectura;
  onRetry: () => void;
  onSessionExpired: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3">
      <p className="text-sm text-destructive">{error.message}</p>

      {error.expired ? (
        <Button type="button" onClick={onSessionExpired}>
          Iniciar sesión nuevamente
        </Button>
      ) : error.recoverable ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Opiniones públicas del partido (WAT-259), con el cliente de WAT-257 y el
 * endpoint de WAT-256: de la más reciente a la más antigua, con autor, texto
 * plano y fecha. Sin feed global: es siempre el listado de UN partido.
 *
 * Los estados no se confunden: cargando, sin opiniones (el servidor confirmó
 * una lista vacía), con opiniones, y error. Un fallo nunca se muestra como
 * «sin opiniones». «Cargar más» pide la página siguiente con el cursor opaco
 * del servidor; si ESA página falla, lo ya cargado se conserva y se reintenta
 * el mismo pedido.
 *
 * El texto de cada opinión se renderiza como texto, nunca como HTML.
 *
 * Se monta con `key` por partido. Al cambiar `refreshKey` (la persona cambió su
 * reseña) se vuelve a pedir la primera página y REEMPLAZA a la lista, así su
 * opinión no aparece dos veces. Una respuesta que llegue tarde (de un pedido
 * reemplazado, de otro partido o de una pantalla desmontada) se descarta.
 */
export function MatchReviewsList({
  matchId,
  accessToken,
  onSessionExpired,
  refreshKey,
}: MatchReviewsListProps) {
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  // El token se renueva solo cada tanto: una renovación no vuelve a pedir.
  const token = useRef(accessToken);
  const tituloId = useId();
  const lista = useRef<HTMLUListElement | null>(null);
  const siguienteController = useRef<AbortController | null>(null);
  // Evita dos pedidos de la misma página con dos clics antes de re-renderizar.
  const siguienteEnCurso = useRef(false);
  // Índice de la primera opinión recién cargada: recibe el foco (teclado, lectores).
  const enfocarDesde = useRef<number | null>(null);

  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null) return;

    const controller = new AbortController();

    listMatchReviews(matchId, accessTokenActual, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;

        setLectura({
          status: 'ready',
          refreshKey,
          items: unir([], page.reviews),
          nextCursor: page.nextCursor,
          siguiente: { status: 'idle' },
        });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isCancelled(caught)) return;

        setLectura({ status: 'error', refreshKey, ...toErrorLectura(caught) });
      });

    return () => {
      controller.abort();
      // Una página siguiente pedida para una lectura anterior ya no vale.
      siguienteController.current?.abort();
      siguienteEnCurso.current = false;
      enfocarDesde.current = null;
    };
  }, [matchId, refreshKey, intento]);

  // Un resultado de un `refreshKey` anterior es viejo: se trata como carga.
  const visible = useMemo<Lectura>(
    () =>
      lectura.status !== 'loading' && lectura.refreshKey !== refreshKey
        ? { status: 'loading' }
        : lectura,
    [lectura, refreshKey],
  );

  const cantidad = visible.status === 'ready' ? visible.items.length : 0;

  useEffect(() => {
    const desde = enfocarDesde.current;
    if (desde === null) return;

    enfocarDesde.current = null;

    const elemento = lista.current?.children.item(desde);
    if (elemento instanceof HTMLElement) elemento.focus();
  }, [cantidad]);

  const reintentarPrimera = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  const cargarMas = useCallback(() => {
    const accessTokenActual = token.current;

    if (
      accessTokenActual === null ||
      visible.status !== 'ready' ||
      visible.nextCursor === null ||
      siguienteEnCurso.current
    ) {
      return;
    }

    const cursor = visible.nextCursor;
    const yaCargadas = visible.items.length;
    const controller = new AbortController();
    siguienteController.current = controller;
    siguienteEnCurso.current = true;

    const actualizar = (cambio: (lecturaActual: Lectura & { status: 'ready' }) => Lectura) =>
      setLectura((actual) =>
        actual.status === 'ready' && actual.refreshKey === refreshKey ? cambio(actual) : actual,
      );

    actualizar((actual) => ({ ...actual, siguiente: { status: 'loading' } }));

    listMatchReviews(matchId, accessTokenActual, { cursor, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;

        siguienteEnCurso.current = false;
        // La lista no cambia mientras esta página está en vuelo: la primera
        // opinión nueva queda justo después de las que ya había. Si la página
        // no suma nada nuevo, ese índice no existe y el foco no se mueve.
        enfocarDesde.current = yaCargadas;
        actualizar((actual) => ({
          ...actual,
          items: unir(actual.items, page.reviews),
          nextCursor: page.nextCursor,
          siguiente: { status: 'idle' },
        }));
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isCancelled(caught)) return;

        siguienteEnCurso.current = false;
        // Lo ya cargado se conserva: sólo falla ESTA página.
        actualizar((actual) => ({
          ...actual,
          siguiente: { status: 'error', ...toErrorLectura(caught) },
        }));
      });
  }, [matchId, refreshKey, visible]);

  // Al desmontar, la página siguiente en vuelo se cancela y se descarta.
  useEffect(() => () => siguienteController.current?.abort(), []);

  return (
    <section aria-labelledby={tituloId} className="flex flex-col gap-3">
      <h2 id={tituloId} className="text-base font-semibold">
        Opiniones del partido
      </h2>

      {visible.status === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Cargando las opiniones…
        </p>
      ) : null}

      {visible.status === 'error' ? (
        <ErrorConAccion
          error={visible}
          onRetry={reintentarPrimera}
          onSessionExpired={onSessionExpired}
        />
      ) : null}

      {visible.status === 'ready' && visible.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay opiniones para este partido.</p>
      ) : null}

      {visible.status === 'ready' && visible.items.length > 0 ? (
        <>
          <ul ref={lista} className="flex flex-col gap-3">
            {visible.items.map((review) => (
              <li
                key={claveDe(review)}
                tabIndex={-1}
                className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Card className="gap-2 p-4">
                  <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-sm font-semibold break-words">{review.authorName}</p>
                    <time dateTime={review.createdAt} className="text-xs text-muted-foreground">
                      {formatReviewDate(review.createdAt)}
                    </time>
                  </div>

                  <p className="text-sm break-words whitespace-pre-wrap">{review.body}</p>
                </Card>
              </li>
            ))}
          </ul>

          {visible.siguiente.status === 'loading' ? (
            <p role="status" className="text-sm text-muted-foreground">
              Cargando más opiniones…
            </p>
          ) : null}

          {visible.siguiente.status === 'error' ? (
            <ErrorConAccion
              error={visible.siguiente}
              onRetry={cargarMas}
              onSessionExpired={onSessionExpired}
            />
          ) : null}

          {visible.nextCursor !== null && visible.siguiente.status !== 'error' ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={visible.siguiente.status === 'loading'}
              aria-busy={visible.siguiente.status === 'loading'}
              onClick={cargarMas}
            >
              Cargar más
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
