import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getRating } from '@/features/ratings/api';
import { isCancelled as isRatingCancelled, RatingsApiError } from '@/features/ratings/types';
import { deleteOwnReview, getOwnReview, saveOwnReview } from './api';
import {
  REVIEW_BODY_MAX_LENGTH,
  ReviewsApiError,
  isCancelled,
  toReviewBody,
  type OwnReview,
} from './types';

interface MatchReviewFormProps {
  matchId: string;
  /**
   * Estado CONFIRMADO de «visto». El detalle sólo monta el formulario cuando lo
   * conoce (nunca mientras carga o si falló la lectura), y este componente
   * sigue montado si después cambia, para no perder el borrador.
   */
  visto: boolean;
  accessToken: string | null;
  onSessionExpired: () => void;
  /**
   * Cambia cada vez que se confirma una nota propia: la reseña exige haber
   * calificado, así que esa señal vuelve a comprobarlo sin recargar la página.
   */
  ratingRefreshKey?: number;
  /**
   * Señal local: se avisa una sola vez por cada publicación, edición o borrado
   * que el servidor CONFIRMÓ (nunca por una lectura, un fallo ni una respuesta
   * descartada), para que quien liste las opiniones del partido las actualice.
   */
  onChanged?: () => void;
}

type Lectura =
  | { status: 'loading' }
  | { status: 'ready'; review: OwnReview | null }
  | { status: 'error'; expired: boolean };

/** Si ya calificó: la API sólo admite reseñar un partido calificado. */
type Calificacion =
  | { status: 'unknown' }
  | { status: 'ready'; rated: boolean }
  | { status: 'error'; expired: boolean };

type Accion = 'save' | 'delete';
type Confirmacion = 'published' | 'updated' | 'deleted';
type ErrorAccion = { message: string; expired: boolean };

const MENSAJE_LECTURA = 'No pudimos cargar tu reseña. Intentá de nuevo.';
const MENSAJE_LECTURA_CALIFICACION = 'No pudimos comprobar tu calificación. Intentá de nuevo.';
const MENSAJE_SESION_VENCIDA = 'La sesión venció. Iniciá sesión nuevamente.';
const MENSAJE_INESPERADO_GUARDADO = 'No pudimos guardar tu reseña. Intentá de nuevo.';
const MENSAJE_INESPERADO_BORRADO = 'No pudimos eliminar tu reseña. Intentá de nuevo.';

const AVISO_VISIBILIDAD =
  'Al publicarla, otros usuarios con sesión iniciada podrán leerla junto a tu nombre visible. Tu calificación no se publica.';

const CONFIRMACIONES: Record<Confirmacion, string> = {
  published: 'Reseña publicada.',
  updated: 'Cambios guardados.',
  deleted: 'Reseña eliminada.',
};

function toErrorAccion(error: unknown, inesperado: string): ErrorAccion {
  if (error instanceof ReviewsApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: inesperado, expired: false };
}

/**
 * Formulario de la reseña propia del partido mostrado (WAT-258): consulta,
 * publicación, edición y eliminación del texto.
 *
 * Elegibilidad para PUBLICAR o EDITAR (la misma que exige la API): partido
 * finalizado (lo decide el detalle), marcado como visto y calificado. Borrar,
 * en cambio, no depende de nada de eso: una reseña propia ya publicada se puede
 * eliminar aunque se haya deshecho «visto». Mientras algo se desconoce (carga,
 * error de lectura) no se ofrece ninguna acción, y nunca se presenta como «sin
 * reseña» ni como «sin calificar».
 *
 * La calificación se lee sólo para decidir si se puede reseñar: no se muestra ni
 * viaja en el pedido. La reseña es independiente de la nota privada.
 *
 * El texto mostrado como confirmado SOLO cambia con la respuesta exitosa del
 * servidor. Un fallo conserva el borrador y la última reseña confirmada, y deja
 * reintentar con los mismos botones. Mientras hay un pedido en curso no se
 * acepta otro (se guarda en un ref, no sólo en estado, para que dos envíos en
 * el mismo instante no pasen).
 *
 * Se monta con `key` por partido y por usuario, así un cambio de cualquiera de
 * los dos arranca de cero; al desmontar se cancelan los pedidos y una respuesta
 * que igual llegue se descarta.
 *
 * Accesibilidad: es un formulario nativo. Durante un pedido el campo queda en
 * `readOnly` y los botones en `aria-disabled` (no `disabled`) para no sacarle el
 * foco a quien navega con teclado. Tras eliminar, el foco pasa al campo, porque
 * el botón que lo tenía desaparece.
 */
export function MatchReviewForm({
  matchId,
  visto,
  accessToken,
  onSessionExpired,
  ratingRefreshKey = 0,
  onChanged,
}: MatchReviewFormProps) {
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intentoLectura, setIntentoLectura] = useState(0);
  const [calificacion, setCalificacion] = useState<Calificacion>({ status: 'unknown' });
  const [intentoCalificacion, setIntentoCalificacion] = useState(0);
  const [borrador, setBorrador] = useState('');
  const [accion, setAccion] = useState<Accion | null>(null);
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);
  const [error, setError] = useState<ErrorAccion | null>(null);

  const controller = useRef<AbortController | null>(null);
  const enCurso = useRef(false);
  const campo = useRef<HTMLTextAreaElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const pendienteFoco = useRef(false);
  // El token se renueva solo cada tanto: una renovación no vuelve a leer, por
  // eso las lecturas y las mutaciones toman el último token sin depender de él.
  const token = useRef(accessToken);
  const avisarCambio = useRef(onChanged);

  const tituloId = useId();
  const campoId = useId();
  const avisoId = useId();
  const contadorId = useId();
  const limiteId = useId();

  useEffect(() => {
    token.current = accessToken;
    avisarCambio.current = onChanged;
  }, [accessToken, onChanged]);

  // Si la pantalla se desmonta mientras espera, la respuesta se descarta.
  useEffect(() => () => controller.current?.abort(), []);

  // Tras eliminar, el botón que tenía el foco desaparece. El foco se mueve
  // después de renderizar, cuando ya existe lo que lo va a recibir: el campo si
  // se puede volver a escribir, o el título de la sección si no.
  useEffect(() => {
    if (!pendienteFoco.current) return;

    pendienteFoco.current = false;
    (campo.current ?? titulo.current)?.focus();
  });

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null) return;

    const lecturaController = new AbortController();

    getOwnReview(matchId, accessTokenActual, lecturaController.signal)
      .then((review) => {
        if (lecturaController.signal.aborted) return;

        setLectura({ status: 'ready', review });
        setBorrador(review?.body ?? '');
        if (review !== null) setCalificacion({ status: 'ready', rated: true });
      })
      .catch((caught: unknown) => {
        if (lecturaController.signal.aborted || isCancelled(caught)) return;

        setLectura({
          status: 'error',
          expired: caught instanceof ReviewsApiError && caught.kind === 'unauthorized',
        });
      });

    return () => lecturaController.abort();
  }, [matchId, intentoLectura]);

  // Si ya calificó. Sólo se pregunta cuando hace falta para decidir: con «visto»
  // confirmado, sin reseña y sin una calificación ya confirmada. Haber publicado
  // una reseña implica haber calificado, así que entonces no se vuelve a leer.
  // Una nota nueva (`ratingRefreshKey`) vuelve a comprobarlo sin pasar por
  // «desconocido», para no desmontar el formulario ni perder el borrador.
  const sinResena = lectura.status === 'ready' && lectura.review === null;
  const calificadaConfirmada = calificacion.status === 'ready' && calificacion.rated;
  const hayQueComprobarCalificacion = visto && sinResena && !calificadaConfirmada;

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null || !hayQueComprobarCalificacion) return;

    const calificacionController = new AbortController();

    getRating(matchId, accessTokenActual, calificacionController.signal)
      .then((rating) => {
        if (calificacionController.signal.aborted) return;

        setCalificacion({ status: 'ready', rated: rating !== null });
      })
      .catch((caught: unknown) => {
        if (calificacionController.signal.aborted || isRatingCancelled(caught)) return;

        setCalificacion({
          status: 'error',
          expired: caught instanceof RatingsApiError && caught.kind === 'unauthorized',
        });
      });

    return () => calificacionController.abort();
  }, [matchId, intentoCalificacion, ratingRefreshKey, hayQueComprobarCalificacion]);

  const reintentarLectura = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntentoLectura((valor) => valor + 1);
  }, []);

  const reintentarCalificacion = useCallback(() => {
    setCalificacion({ status: 'unknown' });
    setIntentoCalificacion((valor) => valor + 1);
  }, []);

  const confirmada = lectura.status === 'ready' ? lectura.review : null;
  const texto = toReviewBody(borrador);
  const largo = [...borrador.trim()].length;
  const excedido = largo > REVIEW_BODY_MAX_LENGTH;
  const sinCambios = texto !== null && texto === confirmada?.body;
  const puedeEnviar = texto !== null && !sinCambios;

  const guardar = useCallback(() => {
    const accessTokenActual = token.current;

    // Sin lectura confirmada, con otro pedido en curso, con un texto inválido o
    // sin cambio real no se envía nada: evita duplicados y pedidos inútiles.
    if (accessTokenActual === null || lectura.status !== 'ready' || enCurso.current) return;
    if (texto === null || texto === lectura.review?.body) return;

    const eraNueva = lectura.review === null;
    const abortController = new AbortController();
    controller.current = abortController;
    enCurso.current = true;
    setAccion('save');
    setConfirmacion(null);
    setError(null);

    saveOwnReview(matchId, texto, accessTokenActual, abortController.signal)
      .then((confirmado) => {
        if (abortController.signal.aborted) return;

        // Se muestra lo que confirma el servidor, no lo que se pidió.
        enCurso.current = false;
        setLectura({ status: 'ready', review: confirmado });
        setBorrador(confirmado.body);
        setCalificacion({ status: 'ready', rated: true });
        setAccion(null);
        setConfirmacion(eraNueva ? 'published' : 'updated');
        avisarCambio.current?.();
      })
      .catch((caught: unknown) => {
        if (abortController.signal.aborted || isCancelled(caught)) return;

        // El borrador queda como está: un fallo nunca lo borra.
        enCurso.current = false;
        setError(toErrorAccion(caught, MENSAJE_INESPERADO_GUARDADO));
        setAccion(null);
      });
  }, [lectura, matchId, texto]);

  const eliminar = useCallback(() => {
    const accessTokenActual = token.current;

    if (accessTokenActual === null || lectura.status !== 'ready' || enCurso.current) return;
    if (lectura.review === null) return;

    const abortController = new AbortController();
    controller.current = abortController;
    enCurso.current = true;
    setAccion('delete');
    setConfirmacion(null);
    setError(null);

    deleteOwnReview(matchId, accessTokenActual, abortController.signal)
      .then(() => {
        if (abortController.signal.aborted) return;

        enCurso.current = false;
        setLectura({ status: 'ready', review: null });
        setBorrador('');
        setAccion(null);
        setConfirmacion('deleted');
        pendienteFoco.current = true;
        avisarCambio.current?.();
      })
      .catch((caught: unknown) => {
        if (abortController.signal.aborted || isCancelled(caught)) return;

        enCurso.current = false;
        setError(toErrorAccion(caught, MENSAJE_INESPERADO_BORRADO));
        setAccion(null);
      });
  }, [lectura, matchId]);

  function alEnviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    guardar();
  }

  function alCambiar(valor: string) {
    setBorrador(valor);
    // Escribir de nuevo descarta el aviso de la acción anterior.
    if (confirmacion !== null) setConfirmacion(null);
    if (error !== null) setError(null);
  }

  if (lectura.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Consultando tu reseña…
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

  const ocupado = accion !== null;
  const yaPublicada = confirmada !== null;
  // Ya publicada, editar sólo exige «visto» (haber reseñado implica haber
  // calificado); sin reseña, además hay que haber calificado.
  const puedeEscribir =
    visto && (yaPublicada || (calificacion.status === 'ready' && calificacion.rated));

  const estado = ocupado
    ? accion === 'delete'
      ? 'Eliminando tu reseña…'
      : yaPublicada
        ? 'Guardando los cambios…'
        : 'Publicando tu reseña…'
    : confirmacion !== null
      ? CONFIRMACIONES[confirmacion]
      : null;

  const botonEliminar = yaPublicada ? (
    <Button
      type="button"
      variant="outline"
      className="text-destructive"
      aria-disabled={ocupado}
      onClick={eliminar}
    >
      {accion === 'delete' ? 'Eliminando…' : 'Eliminar reseña'}
    </Button>
  ) : null;

  const avisos = (
    <>
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
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
    </>
  );

  // Sin reseña y sin poder escribir: se dice qué paso falta, sin ofrecer el campo.
  if (!puedeEscribir && !yaPublicada) {
    return (
      <div className="flex flex-col gap-3">
        <h2
          ref={titulo}
          tabIndex={-1}
          className="rounded-sm text-base font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Reseña del partido
        </h2>

        {!visto ? (
          <p className="text-sm text-muted-foreground">
            Marcá el partido como visto para poder reseñarlo.
          </p>
        ) : calificacion.status === 'unknown' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Consultando si ya calificaste este partido…
          </p>
        ) : calificacion.status === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">
              {calificacion.expired ? MENSAJE_SESION_VENCIDA : MENSAJE_LECTURA_CALIFICACION}
            </p>

            {calificacion.expired ? (
              <Button type="button" onClick={onSessionExpired}>
                Iniciar sesión nuevamente
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={reintentarCalificacion}>
                Reintentar
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Calificá el partido para poder reseñarlo.</p>
        )}

        {avisos}
      </div>
    );
  }

  // Reseña ya publicada pero sin poder editarla (se deshizo «visto»): se muestra
  // el texto y se deja eliminarla, que no depende de la elegibilidad.
  if (!puedeEscribir && confirmada !== null) {
    return (
      <div className="flex flex-col gap-3" aria-busy={ocupado}>
        <h2
          ref={titulo}
          tabIndex={-1}
          className="rounded-sm text-base font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Tu reseña
        </h2>

        <p className="text-sm break-words whitespace-pre-wrap">{confirmada.body}</p>

        <p className="text-sm text-muted-foreground">
          Marcá el partido como visto para poder editar tu reseña.
        </p>

        <div className="flex flex-wrap items-center gap-3">{botonEliminar}</div>

        {avisos}
      </div>
    );
  }

  return (
    <form
      className="flex w-full min-w-0 flex-col gap-3"
      aria-labelledby={tituloId}
      aria-busy={ocupado}
      noValidate
      onSubmit={alEnviar}
    >
      <h2 id={tituloId} className="text-base font-semibold">
        Reseña del partido
      </h2>

      <Label htmlFor={campoId}>Tu reseña</Label>

      <p id={avisoId} className="text-sm text-muted-foreground">
        {AVISO_VISIBILIDAD}
      </p>

      <Textarea
        id={campoId}
        ref={campo}
        value={borrador}
        readOnly={ocupado}
        placeholder="¿Cómo viste el partido?"
        aria-invalid={excedido}
        aria-describedby={`${avisoId} ${contadorId}${excedido ? ` ${limiteId}` : ''}`}
        onChange={(event) => alCambiar(event.target.value)}
      />

      <p
        id={contadorId}
        className={`text-xs tabular-nums ${excedido ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {largo}/{REVIEW_BODY_MAX_LENGTH}
      </p>

      {excedido ? (
        <p id={limiteId} className="text-sm text-destructive">
          La reseña no puede superar los {REVIEW_BODY_MAX_LENGTH} caracteres.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" aria-disabled={ocupado || !puedeEnviar}>
          {accion === 'save'
            ? yaPublicada
              ? 'Guardando…'
              : 'Publicando…'
            : yaPublicada
              ? 'Guardar cambios'
              : 'Publicar reseña'}
        </Button>

        {botonEliminar}
      </div>

      {avisos}
    </form>
  );
}
