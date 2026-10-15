import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentReaction } from './CommentReaction';
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
    expect(screen.queryByText(/me gusta/i)).not.toBeInTheDocument();
  });

  it('lee el estado al montarse con la sala, el comentario y el token', async () => {
    getReactionMock.mockResolvedValue({ count: 3, reacted: true });

    renderReaction();

    const b = await boton();
    expect(b).toHaveTextContent('Me gusta · 3');
    expect(b).toHaveAttribute('aria-pressed', 'true');
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
    expect(b).toHaveTextContent('Me gusta · 5');
    expect(b).toHaveAttribute('aria-pressed', 'false');
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
    expect(screen.queryByText(/me gusta/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    const b = await boton();
    expect(b).toHaveTextContent('Me gusta · 2');
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

describe('CommentReaction: mutación', () => {
  it('marca: pide reacted true y muestra el estado que confirma el servidor', async () => {
    getReactionMock.mockResolvedValue({ count: 2, reacted: false });
    // El servidor confirma 5 aunque localmente serían 3: manda la respuesta.
    setReactionMock.mockResolvedValue({ count: 5, reacted: true });

    const { user } = renderReaction();
    await user.click(await boton());

    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('Me gusta · 5'));
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
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

    await waitFor(() =>
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByRole('button')).toHaveTextContent('Me gusta · 2');
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
    expect(b).toHaveTextContent('Me gusta · 2');

    await act(async () => pendiente.resolve({ count: 3, reacted: true }));

    expect(b).toHaveTextContent('Me gusta · 3');
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
    expect(b).toHaveTextContent('Me gusta · 2');
    expect(b).toHaveAttribute('aria-pressed', 'false');
    expect(b).toHaveAttribute('aria-disabled', 'false');

    await user.click(b);

    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    expect(b).toHaveTextContent('Me gusta · 3');
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
    expect(b).toHaveTextContent('Me gusta · 2');
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
    expect(b).toHaveTextContent('Me gusta · 1');

    // La respuesta de la instancia anterior llega tarde y no se aplica.
    await act(async () => primera.resolve({ count: 99, reacted: true }));

    expect(screen.getByRole('button')).toHaveTextContent('Me gusta · 1');
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
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

    expect(b).toHaveTextContent('Me gusta · 2');
    expect(b).toHaveAttribute('aria-pressed', 'false');
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
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));

    await user.keyboard(' ');
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));

    expect(b).toHaveFocus();
    expect(setReactionMock).toHaveBeenCalledTimes(2);
  });
});
