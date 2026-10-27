import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchRatingSummary } from './MatchRatingSummary';
import { RatingsApiError, type RatingSummary } from './types';

const MATCH_ID = 'match-001';
const OTHER_MATCH_ID = 'match-002';
const TOKEN = 'token-abc';

const { getRatingSummaryMock } = vi.hoisted(() => ({ getRatingSummaryMock: vi.fn() }));

vi.mock('./api', () => ({ getRatingSummary: getRatingSummaryMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const conVotos = (average: number, count: number): RatingSummary => ({ average, count });
const SIN_VOTOS: RatingSummary = { average: null, count: 0 };

interface ElementOptions {
  matchId?: string;
  accessToken?: string | null;
  refreshKey?: number;
  onSessionExpired?: () => void;
}

/** Mismo `key` que en el detalle: por partido. */
function element({
  matchId = MATCH_ID,
  accessToken = TOKEN,
  refreshKey = 0,
  onSessionExpired = () => {},
}: ElementOptions = {}) {
  return (
    <MatchRatingSummary
      key={matchId}
      matchId={matchId}
      accessToken={accessToken}
      refreshKey={refreshKey}
      onSessionExpired={onSessionExpired}
    />
  );
}

function renderSummary(options: ElementOptions = {}) {
  const user = userEvent.setup();
  const onSessionExpired = options.onSessionExpired ?? vi.fn();
  const view = render(element({ ...options, onSessionExpired }));

  return { user, onSessionExpired, ...view };
}

function apiError(kind: ConstructorParameters<typeof RatingsApiError>[0], message = 'Falló.') {
  return new RatingsApiError(kind, message);
}

beforeEach(() => {
  vi.clearAllMocks();
  getRatingSummaryMock.mockReset();
});

describe('Carga', () => {
  it('mientras lee anuncia la carga y no la presenta como sin calificaciones ni como cero votos', async () => {
    getRatingSummaryMock.mockReturnValue(deferred<RatingSummary>().promise);

    renderSummary();

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
    expect(screen.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/voto/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lee con el partido, el bearer y una señal de cancelación', async () => {
    getRatingSummaryMock.mockResolvedValue(SIN_VOTOS);

    renderSummary();
    await screen.findByText(/todavía no hay calificaciones/i);

    expect(getRatingSummaryMock).toHaveBeenCalledTimes(1);
    expect(getRatingSummaryMock).toHaveBeenCalledWith(MATCH_ID, TOKEN, expect.any(AbortSignal));
  });

  it('sin token no pide nada', async () => {
    renderSummary({ accessToken: null });

    expect(getRatingSummaryMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
  });
});

describe('Sin calificaciones y con calificaciones', () => {
  it('sin votos muestra un estado explícito y ninguna cifra', async () => {
    getRatingSummaryMock.mockResolvedValue(SIN_VOTOS);

    renderSummary();

    expect(
      await screen.findByText('Todavía no hay calificaciones para este partido.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/de 5/)).not.toBeInTheDocument();
    expect(screen.queryByText('0,0')).not.toBeInTheDocument();
    expect(screen.queryByText(/0 votos/)).not.toBeInTheDocument();
  });

  it('con votos muestra el promedio con coma decimal y la cantidad', async () => {
    getRatingSummaryMock.mockResolvedValue(conVotos(3.67, 3));

    renderSummary();

    expect(await screen.findByText('3,67')).toBeInTheDocument();
    expect(screen.getByText('de 5 (3 votos)')).toBeInTheDocument();
    expect(screen.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
  });

  it('un único voto va en singular', async () => {
    getRatingSummaryMock.mockResolvedValue(conVotos(4, 1));

    renderSummary();

    expect(await screen.findByText('4,0')).toBeInTheDocument();
    expect(screen.getByText('de 5 (1 voto)')).toBeInTheDocument();
  });

  it('es una sección con nombre y un título de nivel 2, sin regiones vivas cuando ya cargó', async () => {
    getRatingSummaryMock.mockResolvedValue(conVotos(4, 2));

    renderSummary();
    await screen.findByText('4,0');

    expect(
      screen.getByRole('region', { name: 'Calificación de la comunidad' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Calificación de la comunidad' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Errores', () => {
  it('un error avisa, no lo presenta como cero votos y deja reintentar', async () => {
    getRatingSummaryMock.mockRejectedValueOnce(apiError('server'));
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(4.5, 2));

    const { user } = renderSummary();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos cargar el promedio de calificaciones. Intentá de nuevo.',
    );
    expect(screen.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/voto/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('4,5')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getRatingSummaryMock).toHaveBeenCalledTimes(2);
  });

  it('un error de red tampoco se muestra como cero votos', async () => {
    getRatingSummaryMock.mockRejectedValue(apiError('network'));

    renderSummary();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
  });

  it('un 401 ofrece reingresar por el flujo de Auth, no reintentar', async () => {
    getRatingSummaryMock.mockRejectedValue(apiError('unauthorized'));

    const { user, onSessionExpired } = renderSummary();

    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('una lectura cancelada no se anuncia', async () => {
    getRatingSummaryMock.mockRejectedValue(apiError('cancelled'));

    renderSummary();

    await waitFor(() => expect(getRatingSummaryMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Consultando las calificaciones…');
  });
});

describe('Actualización tras guardar la nota propia', () => {
  it('al cambiar refreshKey vuelve a pedir y muestra el resumen nuevo', async () => {
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(5, 2));
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(3.67, 3));

    const { rerender } = renderSummary({ refreshKey: 0 });
    expect(await screen.findByText('5,0')).toBeInTheDocument();

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByText('3,67')).toBeInTheDocument();
    expect(screen.getByText('de 5 (3 votos)')).toBeInTheDocument();
    expect(getRatingSummaryMock).toHaveBeenCalledTimes(2);
  });

  it('mientras actualiza muestra la carga y no el valor anterior; llega el nuevo y lo reemplaza', async () => {
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(5, 2));
    const nuevo = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValueOnce(nuevo.promise);

    const { rerender } = renderSummary({ refreshKey: 0 });
    await screen.findByText('5,0');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
    expect(screen.queryByText('5,0')).not.toBeInTheDocument();
    expect(screen.queryByText(/voto/)).not.toBeInTheDocument();

    await act(async () => nuevo.resolve(conVotos(4, 3)));

    expect(await screen.findByText('4,0')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('primer voto con la consulta pendiente: «sin calificaciones» deja de verse y se indica la carga', async () => {
    getRatingSummaryMock.mockResolvedValueOnce(SIN_VOTOS);
    const nuevo = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValueOnce(nuevo.promise);

    const { rerender } = renderSummary({ refreshKey: 0 });
    await screen.findByText('Todavía no hay calificaciones para este partido.');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
    expect(screen.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();

    await act(async () => nuevo.resolve(conVotos(1, 1)));

    expect(await screen.findByText('1,0')).toBeInTheDocument();
    expect(screen.getByText('de 5 (1 voto)')).toBeInTheDocument();
  });

  it('un error anterior tampoco queda en pantalla mientras se vuelve a pedir', async () => {
    getRatingSummaryMock.mockRejectedValueOnce(apiError('server'));
    const nuevo = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValueOnce(nuevo.promise);

    const { rerender } = renderSummary({ refreshKey: 0 });
    await screen.findByRole('alert');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => nuevo.resolve(conVotos(3, 1)));

    expect(await screen.findByText('3,0')).toBeInTheDocument();
  });

  it('si la actualización falla avisa el error: ni cero votos ni el valor viejo como vigente', async () => {
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(5, 2));
    getRatingSummaryMock.mockRejectedValueOnce(apiError('server'));

    const { rerender } = renderSummary({ refreshKey: 0 });
    await screen.findByText('5,0');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('5,0')).not.toBeInTheDocument();
    expect(screen.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/voto/i)).not.toBeInTheDocument();
  });

  it('la respuesta tardía de un pedido reemplazado no pisa la más reciente', async () => {
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(5, 2));
    const viejo = deferred<RatingSummary>();
    const reciente = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValueOnce(viejo.promise);
    getRatingSummaryMock.mockReturnValueOnce(reciente.promise);

    const { rerender } = renderSummary({ refreshKey: 0 });
    await screen.findByText('5,0');

    rerender(element({ refreshKey: 1 }));
    rerender(element({ refreshKey: 2 }));
    const señalVieja = getRatingSummaryMock.mock.calls[1]![2] as AbortSignal;
    expect(señalVieja.aborted).toBe(true);

    await act(async () => reciente.resolve(conVotos(4, 3)));
    await act(async () => viejo.resolve(conVotos(1, 9)));

    expect(await screen.findByText('4,0')).toBeInTheDocument();
    expect(screen.queryByText('1,0')).not.toBeInTheDocument();
  });

  it('una renovación del token no vuelve a pedir', async () => {
    getRatingSummaryMock.mockResolvedValue(conVotos(4, 2));

    const { rerender } = renderSummary({ accessToken: 'token-viejo' });
    await screen.findByText('4,0');

    rerender(element({ accessToken: 'token-nuevo' }));

    expect(getRatingSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('usa el último token recibido al actualizar', async () => {
    getRatingSummaryMock.mockResolvedValue(conVotos(4, 2));

    const { rerender } = renderSummary({ accessToken: 'token-viejo', refreshKey: 0 });
    await screen.findByText('4,0');

    rerender(element({ accessToken: 'token-nuevo', refreshKey: 1 }));
    await waitFor(() => expect(getRatingSummaryMock).toHaveBeenCalledTimes(2));

    expect(getRatingSummaryMock.mock.calls[1]![1]).toBe('token-nuevo');
  });
});

describe('Cambio de partido y desmontaje', () => {
  it('al pasar de A a B arranca de cero: nada de A hasta que llega el resumen de B', async () => {
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(5, 2));
    getRatingSummaryMock.mockReturnValueOnce(deferred<RatingSummary>().promise);

    const { rerender } = renderSummary({ matchId: MATCH_ID });
    await screen.findByText('5,0');

    rerender(element({ matchId: OTHER_MATCH_ID }));

    expect(screen.queryByText('5,0')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
  });

  it('el resumen tardío de A no pisa a B', async () => {
    const deA = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValueOnce(deA.promise);
    getRatingSummaryMock.mockResolvedValueOnce(SIN_VOTOS);

    const { rerender } = renderSummary({ matchId: MATCH_ID });
    rerender(element({ matchId: OTHER_MATCH_ID }));
    await screen.findByText('Todavía no hay calificaciones para este partido.');

    await act(async () => deA.resolve(conVotos(5, 9)));

    expect(
      screen.getByText('Todavía no hay calificaciones para este partido.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('5,0')).not.toBeInTheDocument();
  });

  it('el error tardío de A no se muestra en B', async () => {
    const deA = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValueOnce(deA.promise);
    getRatingSummaryMock.mockResolvedValueOnce(conVotos(4, 2));

    const { rerender } = renderSummary({ matchId: MATCH_ID });
    rerender(element({ matchId: OTHER_MATCH_ID }));
    await screen.findByText('4,0');

    await act(async () => deA.reject(apiError('server')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('4,0')).toBeInTheDocument();
  });

  it('al desmontar cancela el pedido y descarta la respuesta que igual llegue', async () => {
    const pedido = deferred<RatingSummary>();
    getRatingSummaryMock.mockReturnValue(pedido.promise);
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {});

    const view = renderSummary();
    await screen.findByRole('status');
    const señal = getRatingSummaryMock.mock.calls[0]![2] as AbortSignal;
    expect(señal.aborted).toBe(false);

    view.unmount();

    expect(señal.aborted).toBe(true);
    await act(async () => pedido.resolve(conVotos(4, 2)));
    expect(errores).not.toHaveBeenCalled();

    errores.mockRestore();
  });
});
