import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentReaction, REACTION_REFRESH_MS } from './CommentReaction';
import { ReactionsApiError, type ReactionState } from './types';

const ROOM_ID = 'a1111111-1111-4111-8111-111111111111';
const COMMENT_ID = 'b2222222-2222-4222-8222-222222222222';
const OTHER_COMMENT_ID = 'b3333333-3333-4333-8333-333333333333';
const TOKEN = 'token-abc';

const { getReactionMock, setReactionMock } = vi.hoisted(() => ({
  getReactionMock: vi.fn(),
  setReactionMock: vi.fn(),
}));

vi.mock('./api', () => ({ getReaction: getReactionMock, setReaction: setReactionMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ElementOptions {
  commentId?: string;
  userId?: string;
  accessToken?: string;
  onSessionExpired?: () => void;
}

/** Mismo `key` que en RoomPage: por comentario y por usuario. */
function element({
  commentId = COMMENT_ID,
  userId = 'user-1',
  accessToken = TOKEN,
  onSessionExpired = () => {},
}: ElementOptions = {}) {
  return (
    <CommentReaction
      key={`${commentId}:${userId}`}
      roomId={ROOM_ID}
      commentId={commentId}
      accessToken={accessToken}
      onSessionExpired={onSessionExpired}
    />
  );
}

function renderReaction(options: ElementOptions = {}) {
  const user = userEvent.setup();
  const onSessionExpired = options.onSessionExpired ?? vi.fn();
  const view = render(element({ ...options, onSessionExpired }));

  return { user, onSessionExpired, ...view };
}

const boton = () => screen.findByRole('button', { name: /me gusta/i });

const serverError = () => new ReactionsApiError('server', 'No pudimos actualizar la reacción.');

beforeEach(() => {
  vi.clearAllMocks();
  getReactionMock.mockReset();
  setReactionMock.mockReset();
});

describe('CommentReaction: lectura', () => {
  it('mientras no conoce el estado muestra carga y no asume cero ni «sin reaccionar»', () => {
    getReactionMock.mockReturnValue(new Promise(() => {}));

    renderReaction();

    expect(screen.getByText('Cargando reacción…')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/me gusta/i)).not.toBeInTheDocument();
  });

  it('lee el estado al montarse con la sala, el comentario y el token', async () => {
    getReactionMock.mockResolvedValue({ count: 3, reacted: true });

    renderReaction();

    const b = await boton();
    expect(b).toHaveTextContent('3');
    expect(b).toHaveAccessibleName('Quitar me gusta');
    expect(getReactionMock).toHaveBeenCalledTimes(1);
    expect(getReactionMock).toHaveBeenCalledWith(
      ROOM_ID,
      COMMENT_ID,
      TOKEN,
      expect.any(AbortSignal),
    );
  });

  it('muestra el conteo persistido cuando la persona no reaccionó', async () => {
    getReactionMock.mockResolvedValue({ count: 5, reacted: false });

    renderReaction();

    const b = await boton();
    expect(b).toHaveTextContent('5');
    expect(b).toHaveAccessibleName('Me gusta');
  });

  it('no muta nada sin una acción de la persona', async () => {
    getReactionMock.mockResolvedValue({ count: 1, reacted: false });

    renderReaction();
    await boton();

    expect(setReactionMock).not.toHaveBeenCalled();
  });

  it('un fallo de lectura no se muestra como cero: ofrece reintentar', async () => {
    getReactionMock
      .mockRejectedValueOnce(new ReactionsApiError('network', 'sin red'))
      .mockResolvedValueOnce({ count: 2, reacted: true });

    const { user } = renderReaction();

    // El fallo se anuncia a lectores de pantalla, no solo se muestra.
    expect(await screen.findByRole('alert')).toHaveTextContent(/No pudimos cargar las reacciones/);
    expect(screen.queryByLabelText(/me gusta/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    const b = await boton();
    expect(b).toHaveTextContent('2');
    expect(getReactionMock).toHaveBeenCalledTimes(2);
  });

  it('con la sesión vencida en la lectura ofrece reingresar, no reintentar', async () => {
    getReactionMock.mockRejectedValue(new ReactionsApiError('unauthorized', 'vencida'));

    const { user, onSessionExpired } = renderReaction();

    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció.');

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });
});

describe('CommentReaction: ícono con contador', () => {
  it('es un ícono con su contador, sin el texto «Me gusta» a la vista', async () => {
    getReactionMock.mockResolvedValue({ count: 7, reacted: false });

    renderReaction();

    const b = await boton();
    const icono = b.querySelector('svg');

    expect(icono).not.toBeNull();
    expect(icono).toHaveAttribute('aria-hidden', 'true');
    // Lo único visible es el contador: el texto vive solo en el nombre accesible.
    expect(b).toHaveTextContent(/^7$/);
  });

  it('el nombre accesible cambia con el estado y el contador es su descripción', async () => {
    getReactionMock.mockResolvedValue({ count: 1, reacted: false });
    setReactionMock.mockResolvedValue({ count: 2, reacted: true });

    const { user } = renderReaction();
    const b = await boton();

    expect(b).toHaveAccessibleName('Me gusta');
    expect(b).toHaveAccessibleDescription('1 reacción');

    await user.click(b);

    await waitFor(() => expect(b).toHaveAccessibleName('Quitar me gusta'));
    expect(b).toHaveAccessibleDescription('2 reacciones');
  });

  it('cero reacciones se describe en plural', async () => {
    getReactionMock.mockResolvedValue({ count: 0, reacted: false });

    renderReaction();

    expect(await boton()).toHaveAccessibleDescription('0 reacciones');
  });

  it('diferencia el estado por la forma del ícono y no solo por el color', async () => {
    getReactionMock.mockResolvedValue({ count: 1, reacted: false });
    setReactionMock.mockResolvedValue({ count: 2, reacted: true });

    const { user } = renderReaction();
    const b = await boton();

    // Sin reaccionar: ícono de contorno, botón con borde.
    expect(b.querySelector('svg')).not.toHaveClass('fill-current');
    expect(b.className).toMatch(/\bborder\b/);

    await user.click(b);

    // Reaccionó: ícono relleno y botón relleno.
    await waitFor(() => expect(b.querySelector('svg')).toHaveClass('fill-current'));
    expect(b.className).toMatch(/\bbg-primary\b/);
  });

  it('tiene un área táctil de al menos 44 × 44 px', async () => {
    getReactionMock.mockResolvedValue({ count: 0, reacted: false });

    renderReaction();

    const b = await boton();

    expect(b.className).toMatch(/\bmin-h-11\b/);
    expect(b.className).toMatch(/\bmin-w-11\b/);
  });

  it('anuncia a lectores de pantalla el resultado de la acción propia', async () => {
    getReactionMock.mockResolvedValue({ count: 0, reacted: false });
    setReactionMock
      .mockResolvedValueOnce({ count: 1, reacted: true })
      .mockResolvedValueOnce({ count: 0, reacted: false });

    const { user } = renderReaction();
    const b = await boton();

    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await user.click(b);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Me gusta agregado.'));

    await user.click(b);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Me gusta quitado.'));
  });
});

describe('CommentReaction: mutación', () => {
  it('marca: pide reacted true y muestra el estado que confirma el servidor', async () => {
    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    // El servidor confirma 5 aunque localmente serían 3: manda la respuesta.
    setReactionMock.mockResolvedValue({ count: 5, reacted: true });

    const { user } = renderReaction();
    await user.click(await boton());

    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('5'));
    expect(screen.getByRole('button')).toHaveAccessibleName('Quitar me gusta');
    expect(setReactionMock).toHaveBeenCalledWith(
      ROOM_ID,
      COMMENT_ID,
      true,
      TOKEN,
      expect.any(AbortSignal),
    );
  });

  it('quita: pide reacted false', async () => {
    getReactionMock.mockResolvedValue({ count: 3, reacted: true });
    setReactionMock.mockResolvedValue({ count: 2, reacted: false });

    const { user } = renderReaction();
    await user.click(await boton());

    await waitFor(() => expect(screen.getByRole('button')).toHaveAccessibleName('Me gusta'));
    expect(screen.getByRole('button')).toHaveTextContent('2');
    expect(setReactionMock).toHaveBeenCalledWith(
      ROOM_ID,
      COMMENT_ID,
      false,
      TOKEN,
      expect.any(AbortSignal),
    );
  });

  it('impide duplicados: clics repetidos mientras espera hacen un solo pedido', async () => {
    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    const pendiente = deferred<ReactionState>();
    setReactionMock.mockReturnValue(pendiente.promise);

    const { user } = renderReaction();
    const b = await boton();

    await user.click(b);
    await user.click(b);
    await user.click(b);

    expect(setReactionMock).toHaveBeenCalledTimes(1);
    expect(b).toHaveAttribute('aria-disabled', 'true');
    // Mientras espera, el estado mostrado sigue siendo el último confirmado.
    expect(b).toHaveTextContent('2');
    expect(b).toHaveAccessibleName('Me gusta');

    await act(async () => pendiente.resolve({ count: 3, reacted: true }));

    expect(b).toHaveTextContent('3');
    expect(b).toHaveAttribute('aria-disabled', 'false');
  });

  it('un fallo conserva el estado confirmado, avisa y permite reintentar con el mismo botón', async () => {
    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    setReactionMock
      .mockRejectedValueOnce(serverError())
      .mockResolvedValueOnce({ count: 3, reacted: true });

    const { user } = renderReaction();
    const b = await boton();

    await user.click(b);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos actualizar la reacción.',
    );
    expect(b).toHaveTextContent('2');
    expect(b).toHaveAccessibleName('Me gusta');
    expect(b).toHaveAttribute('aria-disabled', 'false');

    await user.click(b);

    await waitFor(() => expect(b).toHaveAccessibleName('Quitar me gusta'));
    expect(b).toHaveTextContent('3');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(setReactionMock).toHaveBeenCalledTimes(2);
  });

  it('con la sesión vencida al mutar ofrece reingresar y conserva el estado', async () => {
    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    setReactionMock.mockRejectedValue(new ReactionsApiError('unauthorized', 'La sesión venció.'));

    const { user, onSessionExpired } = renderReaction();
    const b = await boton();
    await user.click(b);

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(b).toHaveTextContent('2');
  });

  it('una renovación de token no vuelve a leer y los pedidos usan el token nuevo', async () => {
    getReactionMock.mockResolvedValue({ count: 0, reacted: false });
    setReactionMock.mockResolvedValue({ count: 1, reacted: true });

    const { user, rerender } = renderReaction();
    await boton();

    rerender(element({ accessToken: 'token-nuevo' }));
    await user.click(await boton());

    expect(getReactionMock).toHaveBeenCalledTimes(1);
    expect(setReactionMock).toHaveBeenCalledWith(
      ROOM_ID,
      COMMENT_ID,
      true,
      'token-nuevo',
      expect.any(AbortSignal),
    );
  });
});

describe('CommentReaction: cambio de comentario o usuario', () => {
  it.each([
    ['otro comentario', { commentId: OTHER_COMMENT_ID }],
    ['otro usuario', { userId: 'user-2' }],
  ])('descarta la lectura tardía al pasar a %s', async (_label, cambio) => {
    const primera = deferred<ReactionState>();
    getReactionMock
      .mockReturnValueOnce(primera.promise)
      .mockResolvedValueOnce({ count: 1, reacted: false });

    const { rerender } = renderReaction();
    rerender(element(cambio));

    const b = await boton();
    expect(b).toHaveTextContent('1');

    // La respuesta de la instancia anterior llega tarde y no se aplica.
    await act(async () => primera.resolve({ count: 99, reacted: true }));

    expect(screen.getByRole('button')).toHaveTextContent('1');
    expect(screen.getByRole('button')).toHaveAccessibleName('Me gusta');
  });

  it('descarta la confirmación tardía de una mutación al cambiar de usuario', async () => {
    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    const pendiente = deferred<ReactionState>();
    setReactionMock.mockReturnValue(pendiente.promise);

    const { user, rerender } = renderReaction();
    await user.click(await boton());

    rerender(element({ userId: 'user-2' }));
    const b = await boton();

    await act(async () => pendiente.resolve({ count: 99, reacted: true }));

    expect(b).toHaveTextContent('2');
    expect(b).toHaveAccessibleName('Me gusta');
  });
});

describe('CommentReaction: teclado', () => {
  it('se alcanza con Tab y se activa con Enter y con Espacio sin perder el foco', async () => {
    getReactionMock.mockResolvedValue({ count: 0, reacted: false });
    setReactionMock
      .mockResolvedValueOnce({ count: 1, reacted: true })
      .mockResolvedValueOnce({ count: 0, reacted: false });

    const { user } = renderReaction();
    const b = await boton();

    await user.tab();
    expect(b).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(b).toHaveAccessibleName('Quitar me gusta'));

    await user.keyboard(' ');
    await waitFor(() => expect(b).toHaveAccessibleName('Me gusta'));

    expect(b).toHaveFocus();
    expect(setReactionMock).toHaveBeenCalledTimes(2);
  });
});

describe('CommentReaction: reacciones de otras personas sin recargar', () => {
  /** Avanza el reloj y deja correr las promesas pendientes. */
  const avanzar = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  function setVisibility(estado: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: estado });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Sin variación: cada vuelta es exactamente `REACTION_REFRESH_MS`.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  async function montarListo(inicial: ReactionState = { count: 1, reacted: false }) {
    getReactionMock.mockResolvedValue(inicial);

    const view = render(element());

    await avanzar(0);

    return view;
  }

  it('muestra el cambio que hizo otra persona sin recargar', async () => {
    await montarListo({ count: 1, reacted: false });
    expect(screen.getByRole('button', { name: 'Me gusta' })).toHaveTextContent('1');

    getReactionMock.mockResolvedValue({ count: 3, reacted: false });
    await avanzar(REACTION_REFRESH_MS);

    expect(screen.getByRole('button', { name: 'Me gusta' })).toHaveTextContent('3');
    expect(screen.getByRole('button')).toHaveAccessibleDescription('3 reacciones');
  });

  it('sigue leyendo en cada vuelta y refleja que otra persona quitó la suya', async () => {
    await montarListo({ count: 3, reacted: false });

    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    await avanzar(REACTION_REFRESH_MS);
    expect(screen.getByRole('button')).toHaveTextContent('2');

    getReactionMock.mockResolvedValue({ count: 0, reacted: false });
    await avanzar(REACTION_REFRESH_MS);
    expect(screen.getByRole('button')).toHaveTextContent('0');

    // Una lectura inicial más las dos periódicas.
    expect(getReactionMock).toHaveBeenCalledTimes(3);
  });

  it('también refleja si la propia reacción cambió desde otra sesión', async () => {
    await montarListo({ count: 1, reacted: false });

    getReactionMock.mockResolvedValue({ count: 2, reacted: true });
    await avanzar(REACTION_REFRESH_MS);

    expect(screen.getByRole('button')).toHaveAccessibleName('Quitar me gusta');
  });

  it('lee con la sala, el comentario y el último token', async () => {
    const view = await montarListo();

    view.rerender(element({ accessToken: 'token-nuevo' }));
    await avanzar(REACTION_REFRESH_MS);

    expect(getReactionMock).toHaveBeenLastCalledWith(
      ROOM_ID,
      COMMENT_ID,
      'token-nuevo',
      expect.any(AbortSignal),
    );
  });

  it('no lee periódicamente mientras no conoce el estado ni tras un fallo de lectura', async () => {
    getReactionMock.mockRejectedValue(new ReactionsApiError('network', 'sin red'));

    render(element());
    await avanzar(REACTION_REFRESH_MS * 3);

    expect(getReactionMock).toHaveBeenCalledTimes(1);
  });

  it('un fallo de la lectura periódica es silencioso y conserva el último estado', async () => {
    await montarListo({ count: 4, reacted: true });

    getReactionMock.mockRejectedValue(new ReactionsApiError('network', 'sin red'));
    await avanzar(REACTION_REFRESH_MS);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('4');
    expect(screen.getByRole('button')).toHaveAccessibleName('Quitar me gusta');

    // Y la siguiente vuelta recupera.
    getReactionMock.mockResolvedValue({ count: 5, reacted: true });
    await avanzar(REACTION_REFRESH_MS);

    expect(screen.getByRole('button')).toHaveTextContent('5');
  });

  it('no lee con la pestaña oculta y se pone al día apenas vuelve a estar visible', async () => {
    await montarListo({ count: 1, reacted: false });
    getReactionMock.mockClear();

    setVisibility('hidden');
    await avanzar(REACTION_REFRESH_MS * 3);
    expect(getReactionMock).not.toHaveBeenCalled();

    getReactionMock.mockResolvedValue({ count: 6, reacted: false });
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(getReactionMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).toHaveTextContent('6');
  });

  it('no lee mientras hay una acción propia en curso', async () => {
    await montarListo({ count: 2, reacted: false });
    getReactionMock.mockClear();
    const pendiente = deferred<ReactionState>();
    setReactionMock.mockReturnValue(pendiente.promise);

    fireEvent.click(screen.getByRole('button'));
    await avanzar(REACTION_REFRESH_MS * 2);

    expect(getReactionMock).not.toHaveBeenCalled();

    await act(async () => pendiente.resolve({ count: 3, reacted: true }));
    await avanzar(REACTION_REFRESH_MS);

    // Terminada la acción, la lectura periódica vuelve.
    expect(getReactionMock).toHaveBeenCalledTimes(1);
  });

  it('una lectura pedida antes de la acción propia no pisa el estado que ella confirmó', async () => {
    await montarListo({ count: 2, reacted: false });

    // La lectura periódica queda en camino con un estado que ya es viejo...
    const vieja = deferred<ReactionState>();
    getReactionMock.mockReturnValue(vieja.promise);
    await avanzar(REACTION_REFRESH_MS);

    // ...la persona reacciona y el servidor confirma...
    setReactionMock.mockResolvedValue({ count: 3, reacted: true });
    fireEvent.click(screen.getByRole('button'));
    await avanzar(0);
    expect(screen.getByRole('button')).toHaveTextContent('3');

    // ...y recién entonces llega la lectura vieja: no se aplica.
    await act(async () => vieja.resolve({ count: 2, reacted: false }));

    expect(screen.getByRole('button')).toHaveTextContent('3');
    expect(screen.getByRole('button')).toHaveAccessibleName('Quitar me gusta');
  });

  it('una lectura que llega durante la acción propia no se aplica', async () => {
    await montarListo({ count: 2, reacted: false });

    const periodica = deferred<ReactionState>();
    getReactionMock.mockReturnValue(periodica.promise);
    await avanzar(REACTION_REFRESH_MS);

    const accion = deferred<ReactionState>();
    setReactionMock.mockReturnValue(accion.promise);
    fireEvent.click(screen.getByRole('button'));

    await act(async () => periodica.resolve({ count: 9, reacted: false }));
    expect(screen.getByRole('button')).toHaveTextContent('2');

    await act(async () => accion.resolve({ count: 3, reacted: true }));
    expect(screen.getByRole('button')).toHaveTextContent('3');
  });

  it('los clics repetidos no generan pedidos ni contadores de más aunque haya lecturas periódicas', async () => {
    await montarListo({ count: 0, reacted: false });
    const accion = deferred<ReactionState>();
    setReactionMock.mockReturnValue(accion.promise);

    const b = screen.getByRole('button');

    fireEvent.click(b);
    fireEvent.click(b);
    fireEvent.click(b);
    await avanzar(REACTION_REFRESH_MS);

    expect(setReactionMock).toHaveBeenCalledTimes(1);

    await act(async () => accion.resolve({ count: 1, reacted: true }));

    expect(b).toHaveTextContent('1');
  });

  it('no lee más tras desmontar y descarta una lectura en camino', async () => {
    const view = await montarListo({ count: 1, reacted: false });

    const enCamino = deferred<ReactionState>();
    getReactionMock.mockReturnValue(enCamino.promise);
    await avanzar(REACTION_REFRESH_MS);
    getReactionMock.mockClear();

    view.unmount();
    await act(async () => enCamino.resolve({ count: 50, reacted: true }));
    await avanzar(REACTION_REFRESH_MS * 3);

    expect(getReactionMock).not.toHaveBeenCalled();
  });

  it('cada comentario tiene su propia vuelta, con una variación para no pedir todos a la vez', async () => {
    const aleatorio = vi.mocked(Math.random);

    aleatorio.mockReturnValue(0);
    await montarListo({ count: 1, reacted: false });
    getReactionMock.mockClear();

    // Con la variación mínima (−20 %) la vuelta llega antes del intervalo completo.
    await avanzar(REACTION_REFRESH_MS * 0.8);

    expect(getReactionMock).toHaveBeenCalledTimes(1);
  });
});
