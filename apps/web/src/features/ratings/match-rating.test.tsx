import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchRating } from './MatchRating';
import { RatingsApiError, type RatingValue } from './types';

const MATCH_ID = 'match-001';
const OTHER_MATCH_ID = 'match-002';
const TOKEN = 'token-abc';

const { getRatingMock, saveRatingMock } = vi.hoisted(() => ({
  getRatingMock: vi.fn(),
  saveRatingMock: vi.fn(),
}));

vi.mock('./api', () => ({ getRating: getRatingMock, saveRating: saveRatingMock }));

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
  matchId?: string;
  userId?: string;
  accessToken?: string;
  onSessionExpired?: () => void;
  onSaved?: () => void;
}

/** Mismo `key` que en el detalle: por partido y por usuario. */
function element({
  matchId = MATCH_ID,
  userId = 'user-1',
  accessToken = TOKEN,
  onSessionExpired = () => {},
  onSaved,
}: ElementOptions = {}) {
  return (
    <MatchRating
      key={`${matchId}:${userId}`}
      matchId={matchId}
      accessToken={accessToken}
      onSessionExpired={onSessionExpired}
      onSaved={onSaved}
    />
  );
}

function renderRating(options: ElementOptions = {}) {
  const user = userEvent.setup();
  const onSessionExpired = options.onSessionExpired ?? vi.fn();
  const view = render(element({ ...options, onSessionExpired }));

  return { user, onSessionExpired, ...view };
}

/** El botón de una nota; espera a que la lectura termine. */
const nota = (valor: number) => screen.findByRole('button', { name: `${valor} de 5` });

function apiError(kind: ConstructorParameters<typeof RatingsApiError>[0], message = 'Falló.') {
  return new RatingsApiError(kind, message);
}

beforeEach(() => {
  vi.clearAllMocks();
  getRatingMock.mockReset();
  saveRatingMock.mockReset();
});

describe('Lectura de la nota', () => {
  it('mientras lee anuncia la carga y no ofrece ninguna acción ni la presenta como sin calificar', async () => {
    getRatingMock.mockReturnValue(deferred<RatingValue | null>().promise);

    renderRating();

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando tu calificación…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/todavía no calificaste/i)).not.toBeInTheDocument();
  });

  it('lee con el partido, el bearer y una señal de cancelación', async () => {
    getRatingMock.mockResolvedValue(null);

    renderRating();
    await nota(1);

    expect(getRatingMock).toHaveBeenCalledTimes(1);
    expect(getRatingMock).toHaveBeenCalledWith(MATCH_ID, TOKEN, expect.any(AbortSignal));
  });

  it('sin nota muestra los cinco botones sin marcar y el aviso de ausencia', async () => {
    getRatingMock.mockResolvedValue(null);

    renderRating();

    for (const valor of [1, 2, 3, 4, 5]) {
      expect(await nota(valor)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByText('Todavía no calificaste este partido.')).toBeInTheDocument();
  });

  it('con nota marca solo esa y la anuncia', async () => {
    getRatingMock.mockResolvedValue(4);

    renderRating();

    expect(await nota(4)).toHaveAttribute('aria-pressed', 'true');
    for (const valor of [1, 2, 3, 5]) {
      expect(await nota(valor)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getByText('Tu calificación: 4 de 5.')).toBeInTheDocument();
  });

  it('un error al leer avisa, no lo presenta como sin calificar y deja reintentar', async () => {
    getRatingMock.mockRejectedValueOnce(apiError('server'));
    getRatingMock.mockResolvedValueOnce(3);

    const { user } = renderRating();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos cargar tu calificación. Intentá de nuevo.');
    expect(screen.queryByText(/todavía no calificaste/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3 de 5' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await nota(3)).toHaveAttribute('aria-pressed', 'true');
    expect(getRatingMock).toHaveBeenCalledTimes(2);
  });

  it('una lectura con 401 ofrece reingresar por el flujo de Auth, no reintentar', async () => {
    getRatingMock.mockRejectedValue(apiError('unauthorized'));

    const { user, onSessionExpired } = renderRating();

    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('una lectura cancelada no se anuncia', async () => {
    getRatingMock.mockRejectedValue(apiError('cancelled'));

    renderRating();

    await act(async () => {});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('una renovación del token no vuelve a leer', async () => {
    getRatingMock.mockResolvedValue(2);

    const view = renderRating();
    await nota(2);

    view.rerender(element({ accessToken: 'token-renovado' }));
    await act(async () => {});

    expect(getRatingMock).toHaveBeenCalledTimes(1);
  });

  it('recargar (desmontar y montar de nuevo) vuelve a leer la nota persistida', async () => {
    getRatingMock.mockResolvedValue(5);

    const primera = renderRating();
    expect(await nota(5)).toHaveAttribute('aria-pressed', 'true');
    primera.unmount();

    renderRating();

    expect(await nota(5)).toHaveAttribute('aria-pressed', 'true');
    expect(getRatingMock).toHaveBeenCalledTimes(2);
  });
});

describe('Guardar y editar', () => {
  it('guarda con el partido, la nota, el bearer y una señal de cancelación', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockResolvedValue(5);

    const { user } = renderRating();
    await user.click(await nota(5));

    expect(saveRatingMock).toHaveBeenCalledTimes(1);
    expect(saveRatingMock).toHaveBeenCalledWith(MATCH_ID, 5, TOKEN, expect.any(AbortSignal));
  });

  it('mientras guarda lo anuncia y no cambia la nota hasta que el servidor confirma', async () => {
    getRatingMock.mockResolvedValue(null);
    const pedido = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(pedido.promise);

    const { user } = renderRating();
    await user.click(await nota(4));

    expect(screen.getByText('Guardando tu calificación…')).toBeInTheDocument();
    expect(screen.getByRole('group')).toHaveAttribute('aria-busy', 'true');
    // Aún no hay nota confirmada: nada aparece como elegido.
    expect(await nota(4)).toHaveAttribute('aria-pressed', 'false');

    await act(async () => pedido.resolve(4));

    expect(await nota(4)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Calificación guardada: 4 de 5.')).toBeInTheDocument();
    expect(screen.getByRole('group')).toHaveAttribute('aria-busy', 'false');
  });

  it('edita una nota existente y deja la nueva como única marcada', async () => {
    getRatingMock.mockResolvedValue(4);
    saveRatingMock.mockResolvedValue(2);

    const { user } = renderRating();
    await user.click(await nota(2));

    expect(await screen.findByText('Calificación guardada: 2 de 5.')).toBeInTheDocument();
    expect(await nota(2)).toHaveAttribute('aria-pressed', 'true');
    expect(await nota(4)).toHaveAttribute('aria-pressed', 'false');
    expect(saveRatingMock).toHaveBeenCalledWith(MATCH_ID, 2, TOKEN, expect.any(AbortSignal));
  });

  it('elegir la nota que ya tiene no envía nada', async () => {
    getRatingMock.mockResolvedValue(3);

    const { user } = renderRating();
    await user.click(await nota(3));

    expect(saveRatingMock).not.toHaveBeenCalled();
  });

  it('muestra la nota que confirma el servidor, no la que se pidió', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockResolvedValue(3);

    const { user } = renderRating();
    await user.click(await nota(5));

    expect(await screen.findByText('Calificación guardada: 3 de 5.')).toBeInTheDocument();
    expect(await nota(3)).toHaveAttribute('aria-pressed', 'true');
    expect(await nota(5)).toHaveAttribute('aria-pressed', 'false');
  });

  it('mientras guarda no acepta más envíos: doble clic y otra nota generan un único pedido', async () => {
    getRatingMock.mockResolvedValue(null);
    const pedido = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(pedido.promise);

    const { user } = renderRating();
    await user.dblClick(await nota(5));
    await user.click(await nota(1));

    expect(saveRatingMock).toHaveBeenCalledTimes(1);
    expect(await nota(5)).toHaveAttribute('aria-disabled', 'true');

    await act(async () => pedido.resolve(5));

    expect(await nota(5)).toHaveAttribute('aria-disabled', 'false');
  });

  it('usa el último token recibido al guardar, sin volver a leer', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockResolvedValue(4);

    const { user, ...view } = renderRating();
    await nota(4);
    view.rerender(element({ accessToken: 'token-renovado' }));

    await user.click(await nota(4));

    expect(saveRatingMock).toHaveBeenCalledWith(
      MATCH_ID,
      4,
      'token-renovado',
      expect.any(AbortSignal),
    );
    expect(getRatingMock).toHaveBeenCalledTimes(1);
  });
});

describe('Errores al guardar', () => {
  it('un error avisa, conserva la última nota confirmada y deja reintentar', async () => {
    getRatingMock.mockResolvedValue(4);
    saveRatingMock.mockRejectedValueOnce(apiError('server', 'No pudimos guardar tu calificación.'));
    saveRatingMock.mockResolvedValueOnce(2);

    const { user } = renderRating();
    await user.click(await nota(2));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos guardar tu calificación.',
    );
    expect(await nota(4)).toHaveAttribute('aria-pressed', 'true');
    expect(await nota(2)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Tu calificación: 4 de 5.')).toBeInTheDocument();
    expect(await nota(2)).toHaveAttribute('aria-disabled', 'false');

    await user.click(await nota(2));

    expect(await screen.findByText('Calificación guardada: 2 de 5.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(saveRatingMock).toHaveBeenCalledTimes(2);
  });

  it('un error en la primera calificación no la presenta como guardada', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockRejectedValue(apiError('network', 'No pudimos conectarnos.'));

    const { user } = renderRating();
    await user.click(await nota(5));

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
    expect(screen.getByText('Todavía no calificaste este partido.')).toBeInTheDocument();
    expect(await nota(5)).toHaveAttribute('aria-pressed', 'false');
  });

  it('un conflicto (partido no finalizado o no visto) se avisa con el mensaje de la API traducido', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockRejectedValue(
      apiError('conflict', 'Sólo se puede calificar un partido finalizado y marcado como visto.'),
    );

    const { user } = renderRating();
    await user.click(await nota(5));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sólo se puede calificar un partido finalizado y marcado como visto.',
    );
  });

  it('un error que no es de la API se avisa con un mensaje genérico', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockRejectedValue(new TypeError('boom interno'));

    const { user } = renderRating();
    await user.click(await nota(5));

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos guardar tu calificación. Intentá de nuevo.');
    expect(alerta).not.toHaveTextContent('boom interno');
  });

  it('un 401 al guardar ofrece reingresar por el flujo de Auth', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockRejectedValue(
      apiError('unauthorized', 'La sesión venció. Iniciá sesión nuevamente.'),
    );

    const { user, onSessionExpired } = renderRating();
    await user.click(await nota(5));

    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció');

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('un guardado cancelado no se anuncia ni cambia la nota', async () => {
    getRatingMock.mockResolvedValue(4);
    saveRatingMock.mockRejectedValue(apiError('cancelled'));

    const { user } = renderRating();
    await user.click(await nota(2));

    await act(async () => {});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await nota(4)).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Teclado y accesibilidad', () => {
  it('es un grupo con nombre y cada nota es un botón con su valor', async () => {
    getRatingMock.mockResolvedValue(null);

    renderRating();
    await nota(1);

    expect(screen.getByRole('group', { name: 'Calificá el partido' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Calificá el partido' }),
    ).toBeInTheDocument();
  });

  it('se opera con el teclado: Tab llega al primer botón, Enter guarda y Espacio edita', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockImplementation(async (_matchId: string, rating: RatingValue) => rating);

    const { user } = renderRating();
    await nota(1);

    await user.tab();
    expect(await nota(1)).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByText('Calificación guardada: 1 de 5.')).toBeInTheDocument();

    await user.tab();
    await user.keyboard(' ');
    expect(await screen.findByText('Calificación guardada: 2 de 5.')).toBeInTheDocument();
    expect(saveRatingMock).toHaveBeenCalledTimes(2);
  });

  it('el foco se mantiene en el botón mientras guarda (aria-disabled, no disabled)', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockReturnValue(deferred<RatingValue>().promise);

    const { user } = renderRating();
    await nota(3);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(await nota(3)).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(await nota(3)).toHaveFocus();
    expect(await nota(3)).not.toBeDisabled();
  });

  it('los avisos van en regiones vivas: un único estado y alertas para errores', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockRejectedValue(apiError('server', 'No pudimos guardar tu calificación.'));

    const { user } = renderRating();
    await user.click(await nota(5));

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Cambio de partido, de usuario y desmontaje', () => {
  it('al pasar de A a B arranca de cero: nada de A hasta que llega la lectura de B', async () => {
    getRatingMock.mockImplementation((matchId: string) =>
      matchId === MATCH_ID ? Promise.resolve(4) : deferred<RatingValue | null>().promise,
    );

    const view = renderRating();
    expect(await nota(4)).toHaveAttribute('aria-pressed', 'true');

    view.rerender(element({ matchId: OTHER_MATCH_ID }));

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando tu calificación…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(getRatingMock).toHaveBeenLastCalledWith(OTHER_MATCH_ID, TOKEN, expect.any(AbortSignal));
  });

  it('la lectura tardía de A no pisa a B', async () => {
    const lecturaA = deferred<RatingValue | null>();
    getRatingMock.mockImplementation((matchId: string) =>
      matchId === MATCH_ID ? lecturaA.promise : Promise.resolve(null),
    );

    const view = renderRating();
    view.rerender(element({ matchId: OTHER_MATCH_ID }));
    await nota(1);

    await act(async () => lecturaA.resolve(5));

    expect(await nota(5)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Todavía no calificaste este partido.')).toBeInTheDocument();
  });

  it('el guardado tardío de A no cambia ni bloquea a B', async () => {
    getRatingMock.mockResolvedValue(null);
    const guardadoA = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(guardadoA.promise);

    const { user, ...view } = renderRating();
    await user.click(await nota(5));
    expect(saveRatingMock).toHaveBeenCalledWith(MATCH_ID, 5, TOKEN, expect.any(AbortSignal));

    view.rerender(element({ matchId: OTHER_MATCH_ID }));
    await nota(1);

    await act(async () => guardadoA.resolve(5));

    expect(await nota(5)).toHaveAttribute('aria-pressed', 'false');
    expect(await nota(5)).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText(/guardada/i)).not.toBeInTheDocument();
  });

  it('el error tardío de guardar A no se muestra en B', async () => {
    getRatingMock.mockResolvedValue(null);
    const guardadoA = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(guardadoA.promise);

    const { user, ...view } = renderRating();
    await user.click(await nota(5));
    view.rerender(element({ matchId: OTHER_MATCH_ID }));
    await nota(1);

    await act(async () => guardadoA.reject(apiError('server', 'Falló A.')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('al cambiar de usuario vuelve a leer con su bearer y no conserva la nota del anterior', async () => {
    getRatingMock.mockImplementation((_matchId: string, accessToken: string) =>
      Promise.resolve(accessToken === TOKEN ? 5 : null),
    );

    const view = renderRating();
    expect(await nota(5)).toHaveAttribute('aria-pressed', 'true');

    view.rerender(element({ userId: 'user-2', accessToken: 'token-user-2' }));

    expect(await screen.findByText('Todavía no calificaste este partido.')).toBeInTheDocument();
    expect(await nota(5)).toHaveAttribute('aria-pressed', 'false');
    expect(getRatingMock).toHaveBeenLastCalledWith(
      MATCH_ID,
      'token-user-2',
      expect.any(AbortSignal),
    );
  });

  it('la respuesta tardía del usuario anterior no pisa al nuevo', async () => {
    const lecturaUsuario1 = deferred<RatingValue | null>();
    getRatingMock.mockImplementation((_matchId: string, accessToken: string) =>
      accessToken === TOKEN ? lecturaUsuario1.promise : Promise.resolve(2),
    );

    const view = renderRating();
    view.rerender(element({ userId: 'user-2', accessToken: 'token-user-2' }));
    expect(await nota(2)).toHaveAttribute('aria-pressed', 'true');

    await act(async () => lecturaUsuario1.resolve(5));

    expect(await nota(2)).toHaveAttribute('aria-pressed', 'true');
    expect(await nota(5)).toHaveAttribute('aria-pressed', 'false');
  });

  it('al desmontar cancela los pedidos y descarta la respuesta que igual llegue', async () => {
    const lectura = deferred<RatingValue | null>();
    getRatingMock.mockReturnValue(lectura.promise);
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {});

    const view = renderRating();
    const señal = getRatingMock.mock.calls[0]![2] as AbortSignal;
    expect(señal.aborted).toBe(false);

    view.unmount();

    expect(señal.aborted).toBe(true);
    await act(async () => lectura.resolve(4));
    expect(errores).not.toHaveBeenCalled();

    errores.mockRestore();
  });

  it('al desmontar con un guardado en curso lo cancela y no toca el estado', async () => {
    getRatingMock.mockResolvedValue(null);
    const guardado = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(guardado.promise);
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { user, ...view } = renderRating();
    await user.click(await nota(5));
    const señal = saveRatingMock.mock.calls[0]![3] as AbortSignal;

    view.unmount();

    expect(señal.aborted).toBe(true);
    await act(async () => guardado.resolve(5));
    await waitFor(() => expect(errores).not.toHaveBeenCalled());

    errores.mockRestore();
  });
});

describe('Aviso de guardado confirmado (WAT-215)', () => {
  it('avisa una sola vez por cada guardado que el servidor confirma, y recién entonces', async () => {
    getRatingMock.mockResolvedValue(null);
    const pedido = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(pedido.promise);
    const onSaved = vi.fn();

    const { user } = renderRating({ onSaved });
    await user.click(await nota(4));

    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => pedido.resolve(4));

    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('avisa también al editar una nota existente: cada guardado confirmado cuenta', async () => {
    getRatingMock.mockResolvedValue(2);
    saveRatingMock.mockResolvedValueOnce(5);
    saveRatingMock.mockResolvedValueOnce(3);
    const onSaved = vi.fn();

    const { user } = renderRating({ onSaved });
    await user.click(await nota(5));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await user.click(await nota(3));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  });

  it('leer la nota no avisa', async () => {
    getRatingMock.mockResolvedValue(4);
    const onSaved = vi.fn();

    renderRating({ onSaved });
    await nota(4);

    expect(onSaved).not.toHaveBeenCalled();
  });

  it('un guardado que falla no avisa', async () => {
    getRatingMock.mockResolvedValue(3);
    saveRatingMock.mockRejectedValue(apiError('server'));
    const onSaved = vi.fn();

    const { user } = renderRating({ onSaved });
    await user.click(await nota(5));
    await screen.findByRole('alert');

    expect(onSaved).not.toHaveBeenCalled();
  });

  it('elegir la nota que ya tiene no guarda y por lo tanto no avisa', async () => {
    getRatingMock.mockResolvedValue(3);
    const onSaved = vi.fn();

    const { user } = renderRating({ onSaved });
    await user.click(await nota(3));

    expect(saveRatingMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('un guardado confirmado después de desmontar no avisa', async () => {
    getRatingMock.mockResolvedValue(null);
    const guardado = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(guardado.promise);
    const onSaved = vi.fn();

    const { user, ...view } = renderRating({ onSaved });
    await user.click(await nota(5));

    view.unmount();
    await act(async () => guardado.resolve(5));

    expect(onSaved).not.toHaveBeenCalled();
  });

  it('avisa con la última función recibida, sin volver a leer ni a guardar', async () => {
    getRatingMock.mockResolvedValue(null);
    const pedido = deferred<RatingValue>();
    saveRatingMock.mockReturnValue(pedido.promise);
    const primera = vi.fn();
    const segunda = vi.fn();

    const { user, rerender } = renderRating({ onSaved: primera });
    await user.click(await nota(2));
    rerender(element({ onSaved: segunda }));
    await act(async () => pedido.resolve(2));

    expect(primera).not.toHaveBeenCalled();
    expect(segunda).toHaveBeenCalledTimes(1);
    expect(getRatingMock).toHaveBeenCalledTimes(1);
    expect(saveRatingMock).toHaveBeenCalledTimes(1);
  });

  it('sin función de aviso el guardado funciona igual', async () => {
    getRatingMock.mockResolvedValue(null);
    saveRatingMock.mockResolvedValue(4);

    const { user } = renderRating();
    await user.click(await nota(4));

    expect(await screen.findByText('Calificación guardada: 4 de 5.')).toBeInTheDocument();
  });
});
