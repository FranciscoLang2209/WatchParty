import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOwnStatistics } from './api';
import { StatisticsApiError, type UserStatistics } from './types';
import { useOwnStatistics } from './useOwnStatistics';

vi.mock('./api', () => ({ getOwnStatistics: vi.fn() }));

const getMock = vi.mocked(getOwnStatistics);

const USER_A = 'user-a';
const USER_B = 'user-b';
const TOKEN = 'token-a';

const DE_A: UserStatistics = { watchedMatches: 4, ratings: 3, comments: 9 };
const DE_B: UserStatistics = { watchedMatches: 1, ratings: 0, comments: 2 };

/** Respuesta que el test resuelve o rechaza cuando quiere. */
function deferred() {
  let resolve!: (value: UserStatistics) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<UserStatistics>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function render(userId: string | null = USER_A, accessToken: string | null = TOKEN) {
  return renderHook(({ userId, accessToken }) => useOwnStatistics(userId, accessToken), {
    initialProps: { userId, accessToken },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useOwnStatistics', () => {
  it('sin sesión no pide nada', () => {
    const { result } = render(null, null);

    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'loading' });
  });

  it('carga los totales del usuario con su token', async () => {
    getMock.mockResolvedValue(DE_A);

    const { result } = render();

    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'ready', statistics: DE_A }),
    );
    expect(getMock).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
  });

  it('cada montaje vuelve a consultar: entrar de nuevo al perfil no reusa lo anterior', async () => {
    getMock.mockResolvedValueOnce(DE_A).mockResolvedValueOnce({ ...DE_A, comments: 10 });

    const primera = render();
    await waitFor(() => expect(primera.result.current.state.status).toBe('ready'));
    primera.unmount();

    const segunda = render();

    expect(segunda.result.current.state).toEqual({ status: 'loading' });
    await waitFor(() =>
      expect(segunda.result.current.state).toEqual({
        status: 'ready',
        statistics: { ...DE_A, comments: 10 },
      }),
    );
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('descarta la respuesta de la sesión anterior al cambiar de usuario', async () => {
    const deA = deferred();
    getMock.mockReturnValueOnce(deA.promise).mockResolvedValueOnce(DE_B);

    const { result, rerender } = render();
    rerender({ userId: USER_B, accessToken: 'token-b' });

    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'ready', statistics: DE_B }),
    );

    // La de A llega tarde: no pisa a B.
    await act(async () => deA.resolve(DE_A));

    expect(result.current.state).toEqual({ status: 'ready', statistics: DE_B });
    expect(getMock.mock.calls[0]![1]!.aborted).toBe(true);
  });

  it('volver a un usuario anterior no muestra sus totales viejos', async () => {
    getMock.mockResolvedValueOnce(DE_A).mockResolvedValueOnce(DE_B);

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ userId: USER_B, accessToken: 'token-b' });
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'ready', statistics: DE_B }),
    );

    const deA = deferred();
    getMock.mockReturnValueOnce(deA.promise);
    rerender({ userId: USER_A, accessToken: TOKEN });

    expect(result.current.state).toEqual({ status: 'loading' });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('renovar el token con los totales cargados no vuelve a pedir', async () => {
    getMock.mockResolvedValue(DE_A);

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ userId: USER_A, accessToken: 'token-renovado' });

    expect(result.current.state).toEqual({ status: 'ready', statistics: DE_A });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('renovar el token mientras carga descarta el 401 del token viejo', async () => {
    const vieja = deferred();
    getMock.mockReturnValueOnce(vieja.promise).mockResolvedValueOnce(DE_A);

    const { result, rerender } = render();
    rerender({ userId: USER_A, accessToken: 'token-renovado' });

    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'ready', statistics: DE_A }),
    );
    await act(async () =>
      vieja.reject(new StatisticsApiError('unauthorized', 'La sesión venció.')),
    );

    expect(result.current.state).toEqual({ status: 'ready', statistics: DE_A });
    expect(getMock).toHaveBeenLastCalledWith('token-renovado', expect.any(AbortSignal));
  });

  it('un fallo es un error con reintento, nunca ceros', async () => {
    getMock
      .mockRejectedValueOnce(new StatisticsApiError('server', 'No pudimos cargar tu actividad.'))
      .mockResolvedValueOnce(DE_A);

    const { result } = render();

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: 'error',
        message: 'No pudimos cargar tu actividad.',
        expired: false,
      }),
    );

    act(() => result.current.retry());

    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'ready', statistics: DE_A }),
    );
  });

  it('marca la sesión vencida ante un 401', async () => {
    getMock.mockRejectedValue(new StatisticsApiError('unauthorized', 'La sesión venció.'));

    const { result } = render();

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: 'error',
        message: 'La sesión venció.',
        expired: true,
      }),
    );
  });

  it('no anuncia una consulta cancelada al desmontar', async () => {
    const pendiente = deferred();
    getMock.mockReturnValue(pendiente.promise);

    const { result, unmount } = render();
    const signal = getMock.mock.calls[0]![1]!;
    unmount();

    expect(signal.aborted).toBe(true);
    await act(async () => pendiente.reject(new StatisticsApiError('cancelled', 'Cancelada.')));
    expect(result.current.state).toEqual({ status: 'loading' });
  });
});
