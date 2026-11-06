import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RatingsApiError, type RatingValue } from '@/features/ratings/types';
import { MatchReviewForm } from './MatchReviewForm';
import { ReviewsApiError, type OwnReview } from './types';

const MATCH_ID = 'match-001';
const OTHER_MATCH_ID = 'match-002';
const TOKEN = 'token-abc';

const { getOwnReviewMock, saveOwnReviewMock, deleteOwnReviewMock, getRatingMock } = vi.hoisted(
  () => ({
    getOwnReviewMock: vi.fn(),
    saveOwnReviewMock: vi.fn(),
    deleteOwnReviewMock: vi.fn(),
    getRatingMock: vi.fn(),
  }),
);

vi.mock('./api', () => ({
  getOwnReview: getOwnReviewMock,
  saveOwnReview: saveOwnReviewMock,
  deleteOwnReview: deleteOwnReviewMock,
}));
vi.mock('@/features/ratings/api', () => ({ getRating: getRatingMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const review = (body = 'Gran partido'): OwnReview => ({
  body,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

interface ElementOptions {
  matchId?: string;
  userId?: string;
  visto?: boolean;
  accessToken?: string;
  onSessionExpired?: () => void;
  ratingRefreshKey?: number;
  onChanged?: () => void;
}

/** Mismo `key` que en el detalle: por partido y por usuario. */
function element({
  matchId = MATCH_ID,
  userId = 'user-1',
  visto = true,
  accessToken = TOKEN,
  onSessionExpired = () => {},
  ratingRefreshKey,
  onChanged,
}: ElementOptions = {}) {
  return (
    <MatchReviewForm
      key={`${matchId}:${userId}`}
      matchId={matchId}
      visto={visto}
      accessToken={accessToken}
      onSessionExpired={onSessionExpired}
      ratingRefreshKey={ratingRefreshKey}
      onChanged={onChanged}
    />
  );
}

function renderForm(options: ElementOptions = {}) {
  const user = userEvent.setup();
  const onSessionExpired = options.onSessionExpired ?? vi.fn();
  const onChanged = options.onChanged ?? vi.fn();
  const view = render(element({ ...options, onSessionExpired, onChanged }));

  return { user, onSessionExpired, onChanged, ...view };
}

/** El campo; espera a que la lectura termine. */
const campo = () => screen.findByRole('textbox', { name: 'Tu reseña' });
const publicar = () => screen.getByRole('button', { name: 'Publicar reseña' });
const guardarCambios = () => screen.getByRole('button', { name: 'Guardar cambios' });
const eliminar = () => screen.getByRole('button', { name: 'Eliminar reseña' });

async function escribir(user: ReturnType<typeof userEvent.setup>, texto: string) {
  const textarea = await campo();
  await user.clear(textarea);
  if (texto !== '') await user.type(textarea, texto);
  return textarea;
}

/** Pega de una vez: para textos largos que no vale la pena teclear. */
async function pegar(user: ReturnType<typeof userEvent.setup>, texto: string) {
  const textarea = await campo();
  await user.clear(textarea);
  await user.click(textarea);
  await user.paste(texto);
  return textarea;
}

function reviewsError(kind: ConstructorParameters<typeof ReviewsApiError>[0], message = 'Falló.') {
  return new ReviewsApiError(kind, message);
}

beforeEach(() => {
  vi.clearAllMocks();
  getOwnReviewMock.mockReset();
  saveOwnReviewMock.mockReset();
  deleteOwnReviewMock.mockReset();
  getRatingMock.mockReset();
  // Por defecto: sin reseña y ya calificó, es decir, elegible para publicar.
  getOwnReviewMock.mockResolvedValue(null);
  getRatingMock.mockResolvedValue(4 satisfies RatingValue);
});

describe('Lectura de la reseña', () => {
  it('mientras lee anuncia la carga y no ofrece ninguna acción ni la presenta como sin reseña', async () => {
    getOwnReviewMock.mockReturnValue(deferred<OwnReview | null>().promise);

    renderForm();

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando tu reseña…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('lee con el partido, el bearer y una señal de cancelación', async () => {
    renderForm();
    await campo();

    expect(getOwnReviewMock).toHaveBeenCalledTimes(1);
    expect(getOwnReviewMock).toHaveBeenCalledWith(MATCH_ID, TOKEN, expect.any(AbortSignal));
  });

  it('con reseña publicada carga el texto en el campo', async () => {
    getOwnReviewMock.mockResolvedValue(review('Se me hizo corto'));

    renderForm();

    expect(await campo()).toHaveValue('Se me hizo corto');
    expect(guardarCambios()).toBeInTheDocument();
    expect(eliminar()).toBeInTheDocument();
  });

  it('un error al leer avisa, no lo presenta como sin reseña y deja reintentar', async () => {
    getOwnReviewMock.mockRejectedValueOnce(reviewsError('server'));
    getOwnReviewMock.mockResolvedValueOnce(review('Se me hizo corto'));

    const { user } = renderForm();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos cargar tu reseña. Intentá de nuevo.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar reseña' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await campo()).toHaveValue('Se me hizo corto');
    expect(getOwnReviewMock).toHaveBeenCalledTimes(2);
  });

  it('una lectura con 401 ofrece reingresar por el flujo de Auth, no reintentar', async () => {
    getOwnReviewMock.mockRejectedValue(reviewsError('unauthorized'));

    const { user, onSessionExpired } = renderForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La sesión venció. Iniciá sesión nuevamente.',
    );
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('una lectura cancelada no se anuncia como error', async () => {
    getOwnReviewMock.mockRejectedValue(reviewsError('cancelled'));

    renderForm();

    await waitFor(() => expect(getOwnReviewMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sin token no pide nada', async () => {
    render(
      <MatchReviewForm matchId={MATCH_ID} visto accessToken={null} onSessionExpired={() => {}} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Consultando tu reseña…');
    expect(getOwnReviewMock).not.toHaveBeenCalled();
    expect(getRatingMock).not.toHaveBeenCalled();
  });
});

describe('Elegibilidad', () => {
  it('visto y calificado, sin reseña: ofrece el formulario para publicar', async () => {
    renderForm();

    expect(await campo()).toHaveValue('');
    expect(publicar()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar reseña' })).not.toBeInTheDocument();
  });

  it('sin marcar como visto no ofrece reseñar, indica el paso que falta y no pide la nota', async () => {
    renderForm({ visto: false });

    expect(
      await screen.findByText('Marcá el partido como visto para poder reseñarlo.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(getRatingMock).not.toHaveBeenCalled();
  });

  it('visto pero sin calificar: no ofrece reseñar e indica el paso que falta', async () => {
    getRatingMock.mockResolvedValue(null);

    renderForm();

    expect(
      await screen.findByText('Calificá el partido para poder reseñarlo.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('mientras se desconoce si calificó, no ofrece reseñar ni lo da por no calificado', async () => {
    getRatingMock.mockReturnValue(deferred<RatingValue | null>().promise);

    renderForm();

    expect(
      await screen.findByText('Consultando si ya calificaste este partido…'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Calificá el partido para poder reseñarlo.')).not.toBeInTheDocument();
  });

  it('si falla la lectura de la nota avisa, no la da por no calificada y deja reintentar', async () => {
    getRatingMock.mockRejectedValueOnce(new RatingsApiError('server', 'x'));
    getRatingMock.mockResolvedValueOnce(5);

    const { user } = renderForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos comprobar tu calificación. Intentá de nuevo.',
    );
    expect(screen.queryByText('Calificá el partido para poder reseñarlo.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await campo()).toBeInTheDocument();
    expect(getRatingMock).toHaveBeenCalledTimes(2);
  });

  it('un 401 al leer la nota ofrece reingresar', async () => {
    getRatingMock.mockRejectedValue(new RatingsApiError('unauthorized', 'x'));

    const { user, onSessionExpired } = renderForm();

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('al calificar el partido (ratingRefreshKey) el formulario aparece sin recargar', async () => {
    getRatingMock.mockResolvedValueOnce(null);
    getRatingMock.mockResolvedValueOnce(3);

    const { rerender } = renderForm();
    await screen.findByText('Calificá el partido para poder reseñarlo.');

    rerender(element({ ratingRefreshKey: 1 }));

    expect(await campo()).toBeInTheDocument();
    expect(getRatingMock).toHaveBeenCalledTimes(2);
  });

  it('con reseña ya publicada no vuelve a leer la nota: haber reseñado implica haber calificado', async () => {
    getOwnReviewMock.mockResolvedValue(review());

    renderForm();
    await campo();

    expect(getRatingMock).not.toHaveBeenCalled();
  });

  it('nunca muestra ni envía la nota: la reseña es independiente de la calificación', async () => {
    getRatingMock.mockResolvedValue(2);
    saveOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user } = renderForm();
    await escribir(user, 'Gran partido');
    await user.click(publicar());

    await screen.findByText('Reseña publicada.');
    expect(screen.queryByText(/de 5|calificación: 2/i)).not.toBeInTheDocument();
    expect(saveOwnReviewMock).toHaveBeenCalledWith(
      MATCH_ID,
      'Gran partido',
      TOKEN,
      expect.any(AbortSignal),
    );
    expect(saveOwnReviewMock.mock.calls[0]).toHaveLength(4);
  });

  describe('reseña publicada y «visto» deshecho', () => {
    it('muestra el texto de sólo lectura, no deja editar y sí eliminar', async () => {
      getOwnReviewMock.mockResolvedValue(review('Gran partido'));

      renderForm({ visto: false });

      expect(await screen.findByText('Gran partido')).toBeInTheDocument();
      expect(
        screen.getByText('Marcá el partido como visto para poder editar tu reseña.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Guardar cambios' })).not.toBeInTheDocument();
      expect(eliminar()).toBeInTheDocument();
    });

    it('eliminar funciona sin «visto» y no depende de la nota', async () => {
      getOwnReviewMock.mockResolvedValue(review('Gran partido'));
      deleteOwnReviewMock.mockResolvedValue(undefined);

      const { user, onChanged } = renderForm({ visto: false });
      await screen.findByText('Gran partido');

      await user.click(eliminar());

      expect(await screen.findByText('Reseña eliminada.')).toBeInTheDocument();
      expect(deleteOwnReviewMock).toHaveBeenCalledWith(MATCH_ID, TOKEN, expect.any(AbortSignal));
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Gran partido')).not.toBeInTheDocument();
      expect(
        screen.getByText('Marcá el partido como visto para poder reseñarlo.'),
      ).toBeInTheDocument();
      expect(getRatingMock).not.toHaveBeenCalled();
    });

    it('tras eliminar sin campo, el foco pasa al título de la sección', async () => {
      getOwnReviewMock.mockResolvedValue(review('Gran partido'));
      deleteOwnReviewMock.mockResolvedValue(undefined);

      const { user } = renderForm({ visto: false });
      await screen.findByText('Gran partido');

      await user.click(eliminar());

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Reseña del partido' })).toHaveFocus(),
      );
    });

    it('deshacer «visto» con la reseña montada conserva el borrador al volver a marcarlo', async () => {
      getOwnReviewMock.mockResolvedValue(review('Gran partido'));

      const { user, rerender } = renderForm();
      await escribir(user, 'Borrador sin enviar');

      rerender(element({ visto: false }));
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByText('Gran partido')).toBeInTheDocument();

      rerender(element({ visto: true }));

      expect(await campo()).toHaveValue('Borrador sin enviar');
      expect(getOwnReviewMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Aviso de visibilidad y contador', () => {
  it('avisa antes de publicar que otros usuarios autenticados podrán leerla', async () => {
    renderForm();
    const textarea = await campo();

    const aviso = screen.getByText(/otros usuarios con sesión iniciada podrán leerla/i);
    expect(aviso).toHaveTextContent('Tu calificación no se publica.');
    expect(textarea.getAttribute('aria-describedby')).toContain(aviso.id);
  });

  it('el aviso está visible antes de que la persona escriba', async () => {
    renderForm();
    await campo();

    expect(screen.getByText(/podrán leerla junto a tu nombre visible/i)).toBeVisible();
  });

  it('muestra el contador contra el límite y lo actualiza al escribir', async () => {
    const { user } = renderForm();
    await campo();
    expect(screen.getByText('0/500')).toBeInTheDocument();

    await escribir(user, 'Hola');

    expect(screen.getByText('4/500')).toBeInTheDocument();
  });

  it('cuenta caracteres y no unidades UTF-16, y sin los espacios exteriores', async () => {
    const { user } = renderForm();
    await pegar(user, '  ⚽🏆  ');

    expect(screen.getByText('2/500')).toBeInTheDocument();
  });

  it('500 caracteres entran: sin error y con el botón disponible', async () => {
    const { user } = renderForm();
    const textarea = await pegar(user, 'a'.repeat(500));

    expect(screen.getByText('500/500')).toBeInTheDocument();
    expect(screen.queryByText(/no puede superar/i)).not.toBeInTheDocument();
    expect(textarea).toHaveAttribute('aria-invalid', 'false');
    expect(publicar()).toHaveAttribute('aria-disabled', 'false');
  });

  it('500 emojis entran (la API cuenta caracteres): el campo no usa maxLength', async () => {
    const { user } = renderForm();
    const textarea = await pegar(user, '🏆'.repeat(500));

    expect(screen.getByText('500/500')).toBeInTheDocument();
    expect(textarea).not.toHaveAttribute('maxlength');
    expect(publicar()).toHaveAttribute('aria-disabled', 'false');
  });

  it('501 caracteres muestran el límite, marcan el campo y no permiten enviar', async () => {
    const { user } = renderForm();
    const textarea = await pegar(user, 'a'.repeat(501));

    expect(screen.getByText('501/500')).toBeInTheDocument();
    const mensaje = screen.getByText('La reseña no puede superar los 500 caracteres.');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea.getAttribute('aria-describedby')).toContain(mensaje.id);
    expect(publicar()).toHaveAttribute('aria-disabled', 'true');

    await user.click(publicar());

    expect(saveOwnReviewMock).not.toHaveBeenCalled();
  });

  it('vacío o de sólo espacios no se puede enviar', async () => {
    const { user } = renderForm();
    await campo();

    expect(publicar()).toHaveAttribute('aria-disabled', 'true');

    await escribir(user, '   ');
    await user.click(publicar());

    expect(saveOwnReviewMock).not.toHaveBeenCalled();
  });

  it('el campo tiene nombre accesible propio, independiente del placeholder', async () => {
    renderForm();

    expect(await screen.findByLabelText('Tu reseña')).toBeInTheDocument();
  });
});

describe('Publicar y editar', () => {
  it('publica con el texto sin espacios exteriores, anuncia el guardado y avisa una vez', async () => {
    saveOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user, onChanged } = renderForm();
    await escribir(user, '  Gran partido  ');

    await user.click(publicar());

    expect(await screen.findByText('Reseña publicada.')).toBeInTheDocument();
    expect(saveOwnReviewMock).toHaveBeenCalledTimes(1);
    expect(saveOwnReviewMock).toHaveBeenCalledWith(
      MATCH_ID,
      'Gran partido',
      TOKEN,
      expect.any(AbortSignal),
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(guardarCambios()).toBeInTheDocument();
    expect(eliminar()).toBeInTheDocument();
  });

  it('mientras publica anuncia el progreso, deja el campo en sólo lectura y no pierde el foco', async () => {
    const respuesta = deferred<OwnReview>();
    saveOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user } = renderForm();
    const textarea = await escribir(user, 'Gran partido');
    await user.click(publicar());

    expect(await screen.findByText('Publicando tu reseña…')).toBeInTheDocument();
    expect(textarea).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Publicando…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Publicando…' })).not.toBeDisabled();

    await act(async () => respuesta.resolve(review('Gran partido')));

    expect(textarea).not.toHaveAttribute('readonly');
  });

  it('muestra el texto que confirma el servidor, no el que se pidió', async () => {
    saveOwnReviewMock.mockResolvedValue(review('Texto del servidor'));

    const { user } = renderForm();
    await escribir(user, 'Otro texto');
    await user.click(publicar());

    await screen.findByText('Reseña publicada.');
    expect(await campo()).toHaveValue('Texto del servidor');
  });

  it('edita la reseña existente: sólo deja guardar si hay un cambio real', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    saveOwnReviewMock.mockResolvedValue(review('Gran partido, editado'));

    const { user, onChanged } = renderForm();
    await campo();
    expect(guardarCambios()).toHaveAttribute('aria-disabled', 'true');

    await user.click(guardarCambios());
    expect(saveOwnReviewMock).not.toHaveBeenCalled();

    await escribir(user, 'Gran partido, editado');
    expect(guardarCambios()).toHaveAttribute('aria-disabled', 'false');
    await user.click(guardarCambios());

    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(saveOwnReviewMock).toHaveBeenCalledWith(
      MATCH_ID,
      'Gran partido, editado',
      TOKEN,
      expect.any(AbortSignal),
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(guardarCambios()).toHaveAttribute('aria-disabled', 'true');
  });

  it('sólo cambiar los espacios exteriores no cuenta como cambio', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user } = renderForm();
    await escribir(user, ' Gran partido ');

    expect(guardarCambios()).toHaveAttribute('aria-disabled', 'true');
    await user.click(guardarCambios());
    expect(saveOwnReviewMock).not.toHaveBeenCalled();
  });

  it('escribir de nuevo descarta el aviso de la acción anterior', async () => {
    saveOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user } = renderForm();
    await escribir(user, 'Gran partido');
    await user.click(publicar());
    await screen.findByText('Reseña publicada.');

    await user.type(await campo(), '!');

    expect(screen.queryByText('Reseña publicada.')).not.toBeInTheDocument();
  });

  it('una lectura no avisa cambio alguno', async () => {
    getOwnReviewMock.mockResolvedValue(review());

    const { onChanged } = renderForm();
    await campo();

    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('Eliminar', () => {
  it('elimina, vacía el campo, anuncia el borrado, avisa una vez y devuelve el foco al campo', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    deleteOwnReviewMock.mockResolvedValue(undefined);

    const { user, onChanged } = renderForm();
    const textarea = await campo();

    await user.click(eliminar());

    expect(await screen.findByText('Reseña eliminada.')).toBeInTheDocument();
    expect(deleteOwnReviewMock).toHaveBeenCalledTimes(1);
    expect(deleteOwnReviewMock).toHaveBeenCalledWith(MATCH_ID, TOKEN, expect.any(AbortSignal));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Eliminar reseña' })).not.toBeInTheDocument();
    expect(publicar()).toBeInTheDocument();
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('tras eliminar se puede volver a publicar sin recargar ni volver a leer la nota', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    deleteOwnReviewMock.mockResolvedValue(undefined);
    saveOwnReviewMock.mockResolvedValue(review('Otra opinión'));

    const { user } = renderForm();
    await campo();
    await user.click(eliminar());
    await screen.findByText('Reseña eliminada.');

    await escribir(user, 'Otra opinión');
    await user.click(publicar());

    expect(await screen.findByText('Reseña publicada.')).toBeInTheDocument();
    expect(getRatingMock).not.toHaveBeenCalled();
  });

  it('mientras elimina anuncia el progreso y no acepta otro pedido', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    const respuesta = deferred<void>();
    deleteOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user } = renderForm();
    await campo();
    await user.click(eliminar());

    expect(await screen.findByText('Eliminando tu reseña…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Eliminando…' }));
    await user.click(guardarCambios());

    expect(deleteOwnReviewMock).toHaveBeenCalledTimes(1);
    expect(saveOwnReviewMock).not.toHaveBeenCalled();

    await act(async () => respuesta.resolve());
  });

  it('un fallo al eliminar avisa, conserva la reseña confirmada y el texto, y deja reintentar', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    deleteOwnReviewMock.mockRejectedValueOnce(reviewsError('server', 'No pudimos eliminar.'));
    deleteOwnReviewMock.mockResolvedValueOnce(undefined);

    const { user, onChanged } = renderForm();
    await campo();

    await user.click(eliminar());

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos eliminar.');
    expect(await campo()).toHaveValue('Gran partido');
    expect(onChanged).not.toHaveBeenCalled();

    await user.click(eliminar());

    expect(await screen.findByText('Reseña eliminada.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('Fallos al guardar', () => {
  it('un error conserva el borrador, avisa sin avisar cambio y deja reintentar con el mismo botón', async () => {
    saveOwnReviewMock.mockRejectedValueOnce(reviewsError('server', 'No pudimos guardar.'));
    saveOwnReviewMock.mockResolvedValueOnce(review('Gran partido'));

    const { user, onChanged } = renderForm();
    const textarea = await escribir(user, 'Gran partido');

    await user.click(publicar());

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos guardar.');
    expect(textarea).toHaveValue('Gran partido');
    expect(onChanged).not.toHaveBeenCalled();
    expect(publicar()).toHaveAttribute('aria-disabled', 'false');

    await user.click(publicar());

    expect(await screen.findByText('Reseña publicada.')).toBeInTheDocument();
    expect(saveOwnReviewMock).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('un fallo al editar conserva la última reseña confirmada y el texto editado', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    saveOwnReviewMock.mockRejectedValue(reviewsError('network', 'Sin conexión.'));

    const { user } = renderForm();
    const textarea = await escribir(user, 'Gran partido, editado');

    await user.click(guardarCambios());

    expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión.');
    expect(textarea).toHaveValue('Gran partido, editado');
    expect(guardarCambios()).toHaveAttribute('aria-disabled', 'false');
  });

  it('un 409 (el partido dejó de ser reseñable) se avisa con su propio mensaje y conserva el borrador', async () => {
    saveOwnReviewMock.mockRejectedValue(
      reviewsError(
        'conflict',
        'Para reseñar un partido tiene que estar finalizado, marcado como visto y calificado.',
      ),
    );

    const { user } = renderForm();
    const textarea = await escribir(user, 'Gran partido');
    await user.click(publicar());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Para reseñar un partido tiene que estar finalizado, marcado como visto y calificado.',
    );
    expect(textarea).toHaveValue('Gran partido');
  });

  it('un error que no es de la API usa el mensaje propio, sin detalles', async () => {
    saveOwnReviewMock.mockRejectedValue(new Error('postgres://u:pw@host'));

    const { user } = renderForm();
    await escribir(user, 'Gran partido');
    await user.click(publicar());

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos guardar tu reseña. Intentá de nuevo.');
    expect(alerta).not.toHaveTextContent('postgres');
  });

  it('ante un 401 al guardar ofrece reingresar y conserva el borrador', async () => {
    saveOwnReviewMock.mockRejectedValue(reviewsError('unauthorized', 'La sesión venció.'));

    const { user, onSessionExpired } = renderForm();
    const textarea = await escribir(user, 'Gran partido');
    await user.click(publicar());

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue('Gran partido');
  });

  it('una cancelación al guardar no se anuncia como error', async () => {
    saveOwnReviewMock.mockRejectedValue(reviewsError('cancelled'));

    const { user } = renderForm();
    await escribir(user, 'Gran partido');
    await user.click(publicar());

    await waitFor(() => expect(saveOwnReviewMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Envíos duplicados', () => {
  it('mientras guarda no acepta más envíos: doble clic genera un único pedido', async () => {
    const respuesta = deferred<OwnReview>();
    saveOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user } = renderForm();
    await escribir(user, 'Gran partido');

    await user.dblClick(publicar());

    expect(saveOwnReviewMock).toHaveBeenCalledTimes(1);

    await act(async () => respuesta.resolve(review('Gran partido')));
  });

  it('Enter sobre el botón mientras guarda tampoco duplica el pedido', async () => {
    const respuesta = deferred<OwnReview>();
    saveOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user } = renderForm();
    await escribir(user, 'Gran partido');
    await user.click(publicar());

    screen.getByRole('button', { name: 'Publicando…' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(saveOwnReviewMock).toHaveBeenCalledTimes(1);

    await act(async () => respuesta.resolve(review('Gran partido')));
  });

  it('eliminar mientras guarda no dispara un borrado', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    const respuesta = deferred<OwnReview>();
    saveOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user } = renderForm();
    await escribir(user, 'Gran partido, editado');
    await user.click(guardarCambios());
    await screen.findByText('Guardando los cambios…');

    await user.click(eliminar());

    expect(deleteOwnReviewMock).not.toHaveBeenCalled();

    await act(async () => respuesta.resolve(review('Gran partido, editado')));
  });
});

describe('Sesión, partido y desmontaje', () => {
  it('una respuesta tardía de guardar tras desmontar se descarta y no avisa cambio', async () => {
    const respuesta = deferred<OwnReview>();
    saveOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user, onChanged, unmount } = renderForm();
    await escribir(user, 'Gran partido');
    await user.click(publicar());
    await screen.findByText('Publicando tu reseña…');
    const señal = saveOwnReviewMock.mock.calls[0]![3] as AbortSignal;

    unmount();
    await act(async () => respuesta.resolve(review('Gran partido')));

    expect(señal.aborted).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('una respuesta tardía de eliminar tras desmontar se descarta y no avisa cambio', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    const respuesta = deferred<void>();
    deleteOwnReviewMock.mockReturnValue(respuesta.promise);

    const { user, onChanged, unmount } = renderForm();
    await campo();
    await user.click(eliminar());
    await screen.findByText('Eliminando tu reseña…');

    unmount();
    await act(async () => respuesta.resolve());

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('la lectura tardía del partido A no pisa al partido B', async () => {
    const lecturaA = deferred<OwnReview | null>();
    getOwnReviewMock.mockImplementation((matchId: string) =>
      matchId === MATCH_ID ? lecturaA.promise : Promise.resolve(review('Reseña de B')),
    );

    const { rerender } = renderForm();
    rerender(element({ matchId: OTHER_MATCH_ID }));

    expect(await campo()).toHaveValue('Reseña de B');

    await act(async () => lecturaA.resolve(review('Reseña de A')));

    expect(screen.getByRole('textbox', { name: 'Tu reseña' })).toHaveValue('Reseña de B');
    expect(screen.queryByText('Reseña de A')).not.toBeInTheDocument();
  });

  it('la respuesta tardía de guardar en A no cambia ni bloquea el formulario de B', async () => {
    const guardadoA = deferred<OwnReview>();
    saveOwnReviewMock.mockImplementation((matchId: string) =>
      matchId === MATCH_ID ? guardadoA.promise : Promise.resolve(review('Reseña de B')),
    );
    getOwnReviewMock.mockResolvedValue(null);

    const { user, rerender, onChanged } = renderForm();
    await escribir(user, 'Reseña de A');
    await user.click(publicar());
    await screen.findByText('Publicando tu reseña…');

    rerender(element({ matchId: OTHER_MATCH_ID, onChanged }));
    const textareaB = await campo();
    expect(textareaB).toHaveValue('');
    expect(publicar()).toHaveAttribute('aria-disabled', 'true'); // vacío, no «ocupado»

    await act(async () => guardadoA.resolve(review('Reseña de A')));

    expect(textareaB).toHaveValue('');
    expect(screen.queryByText('Reseña publicada.')).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    await user.type(textareaB, 'Reseña de B');
    await user.click(publicar());

    expect(await screen.findByText('Reseña publicada.')).toBeInTheDocument();
    expect(saveOwnReviewMock).toHaveBeenLastCalledWith(
      OTHER_MATCH_ID,
      'Reseña de B',
      TOKEN,
      expect.any(AbortSignal),
    );
  });

  it('el error tardío de guardar en A no se muestra en B', async () => {
    const guardadoA = deferred<OwnReview>();
    saveOwnReviewMock.mockReturnValue(guardadoA.promise);

    const { user, rerender } = renderForm();
    await escribir(user, 'Reseña de A');
    await user.click(publicar());
    await screen.findByText('Publicando tu reseña…');

    rerender(element({ matchId: OTHER_MATCH_ID }));
    await campo();

    await act(async () => guardadoA.reject(reviewsError('server', 'Falló A.')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('al cambiar de usuario arranca de cero: vuelve a leer con su bearer y no conserva el borrador', async () => {
    getOwnReviewMock.mockResolvedValue(null);

    const { user, rerender } = renderForm({ userId: 'user-1' });
    await escribir(user, 'Borrador del usuario 1');

    getOwnReviewMock.mockResolvedValue(review('Reseña del usuario 2'));
    rerender(element({ userId: 'user-2', accessToken: 'token-2' }));

    expect(await campo()).toHaveValue('Reseña del usuario 2');
    expect(getOwnReviewMock).toHaveBeenLastCalledWith(MATCH_ID, 'token-2', expect.any(AbortSignal));
  });

  it('la lectura tardía de otro usuario no se muestra', async () => {
    const lecturaUsuario1 = deferred<OwnReview | null>();
    getOwnReviewMock.mockReturnValueOnce(lecturaUsuario1.promise);

    const { rerender } = renderForm({ userId: 'user-1' });

    getOwnReviewMock.mockResolvedValue(null);
    rerender(element({ userId: 'user-2', accessToken: 'token-2' }));
    expect(await campo()).toHaveValue('');

    await act(async () => lecturaUsuario1.resolve(review('Reseña privada del usuario 1')));

    expect(screen.queryByText('Reseña privada del usuario 1')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Tu reseña' })).toHaveValue('');
  });

  it('renovar el token no vuelve a leer ni pierde el borrador, y el guardado usa el token nuevo', async () => {
    saveOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user, rerender } = renderForm();
    await escribir(user, 'Gran partido');

    rerender(element({ accessToken: 'token-renovado' }));

    expect(getOwnReviewMock).toHaveBeenCalledTimes(1);
    expect(await campo()).toHaveValue('Gran partido');

    await user.click(publicar());

    await screen.findByText('Reseña publicada.');
    expect(saveOwnReviewMock).toHaveBeenCalledWith(
      MATCH_ID,
      'Gran partido',
      'token-renovado',
      expect.any(AbortSignal),
    );
  });
});

describe('Teclado', () => {
  it('Tab llega al campo y luego al botón; Enter en el botón publica', async () => {
    saveOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user } = renderForm();
    const textarea = await campo();

    await user.tab();
    expect(textarea).toHaveFocus();

    await user.keyboard('Gran partido');
    await user.tab();
    expect(publicar()).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(await screen.findByText('Reseña publicada.')).toBeInTheDocument();
    expect(saveOwnReviewMock).toHaveBeenCalledTimes(1);
  });

  it('Espacio sobre el botón también publica', async () => {
    saveOwnReviewMock.mockResolvedValue(review('Gran partido'));

    const { user } = renderForm();
    await escribir(user, 'Gran partido');

    publicar().focus();
    await user.keyboard(' ');

    expect(await screen.findByText('Reseña publicada.')).toBeInTheDocument();
  });

  it('Enter dentro del campo agrega un salto de línea y no envía el formulario', async () => {
    const { user } = renderForm();
    const textarea = await escribir(user, 'Línea uno');

    await user.keyboard('{Enter}Línea dos');

    expect(textarea).toHaveValue('Línea uno\nLínea dos');
    expect(saveOwnReviewMock).not.toHaveBeenCalled();
  });

  it('el botón de eliminar se alcanza con Tab y se opera con Enter', async () => {
    getOwnReviewMock.mockResolvedValue(review('Gran partido'));
    deleteOwnReviewMock.mockResolvedValue(undefined);

    const { user } = renderForm();
    await campo();

    await user.tab(); // campo
    await user.tab(); // guardar cambios
    await user.tab(); // eliminar
    expect(eliminar()).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(await screen.findByText('Reseña eliminada.')).toBeInTheDocument();
  });
});
