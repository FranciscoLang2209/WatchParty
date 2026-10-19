import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWatchedHistoryPage } from './api';
import {
  WatchedApiError,
  type WatchedHistoryCursor,
  type WatchedHistoryItem,
  type WatchedHistoryPage,
} from './types';
import { useWatchedHistory } from './useWatchedHistory';

vi.mock('./api', () => ({ listWatchedHistoryPage: vi.fn() }));

const listMock = vi.mocked(listWatchedHistoryPage);

const USER_A = 'user-a';
const USER_B = 'user-b';
const TOKEN = 'token-a';

function item(n: number): WatchedHistoryItem {
  return {
    match: {
      id: `m${n}`,
      homeTeam: `Local ${n}`,
      homeTeamId: `h${n}`,
      awayTeam: `Visitante ${n}`,
      awayTeamId: `a${n}`,
      kickoffAt: '2026-10-10T21:00:00Z',
      status: 'finished',
      score: null,
    },
    watchedAt: `2026-10-${String(20 - n).padStart(2, '0')}T12:00:00.000Z`,
  };
}

function cursor(n: number): WatchedHistoryCursor {
  return { watchedAt: item(n).watchedAt, matchId: `m${n}` };
}

/** Respuesta que el test resuelve o rechaza cuando quiere. */
function deferred() {
  let resolve!: (page: WatchedHistoryPage) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<WatchedHistoryPage>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signalOf(callIndex: number): AbortSignal {
  return listMock.mock.calls[callIndex]![1]!.signal!;
}

function render(userId: string | null = USER_A, accessToken: string | null = TOKEN) {
  return renderHook(({ userId, accessToken }) => useWatchedHistory(userId, accessToken), {
    initialProps: { userId, accessToken },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useWatchedHistory', () => {
  it('arranca cargando y muestra la primera página con el bearer de la sesión', async () => {
    listMock.mockResolvedValueOnce({ items: [item(1), item(2)], nextCursor: cursor(2) });

    const { result } = render();

    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({
      status: 'ready',
      items: [item(1), item(2)],
      hasMore: true,
      more: 'idle',
      moreError: null,
    });
    expect(listMock).toHaveBeenCalledWith(TOKEN, { signal: expect.any(AbortSignal) });
  });

  it('un historial vacío queda listo, sin más páginas', async () => {
    listMock.mockResolvedValueOnce({ items: [], nextCursor: null });

    const { result } = render();

    await waitFor(() => expect(result.current.state).toMatchObject({ items: [], hasMore: false }));
  });

  it('sin sesión no pide nada', () => {
    const { result } = render(null, null);

    expect(result.current.state).toEqual({ status: 'loading' });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('agrega las páginas sucesivas en orden hasta el fin de la lista', async () => {
    listMock
      .mockResolvedValueOnce({ items: [item(1), item(2)], nextCursor: cursor(2) })
      .mockResolvedValueOnce({ items: [item(3), item(4)], nextCursor: cursor(4) })
      .mockResolvedValueOnce({ items: [item(5)], nextCursor: null });

    const { result } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ more: 'idle', hasMore: true }),
    );
    expect(listMock).toHaveBeenLastCalledWith(TOKEN, {
      cursor: cursor(2),
      signal: expect.any(AbortSignal),
    });

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state).toMatchObject({ hasMore: false }));
    expect(listMock).toHaveBeenLastCalledWith(TOKEN, {
      cursor: cursor(4),
      signal: expect.any(AbortSignal),
    });

    const state = result.current.state;
    expect(state.status === 'ready' && state.items.map((i) => i.match.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);

    // Fin de la lista: pedir más no consulta al servidor.
    act(() => result.current.loadMore());
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  it('no repite un partido que ya estaba en una página anterior', async () => {
    listMock
      .mockResolvedValueOnce({ items: [item(1), item(2)], nextCursor: cursor(2) })
      .mockResolvedValueOnce({ items: [item(2), item(3)], nextCursor: null });

    const { result } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state).toMatchObject({ hasMore: false }));

    const state = result.current.state;
    expect(state.status === 'ready' && state.items.map((i) => i.match.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('no manda un segundo pedido mientras la página siguiente está en camino', async () => {
    const siguiente = deferred();
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockReturnValueOnce(siguiente.promise);

    const { result } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    act(() => result.current.loadMore());

    expect(result.current.state).toMatchObject({ more: 'loading' });
    expect(listMock).toHaveBeenCalledTimes(2);

    await act(async () => siguiente.resolve({ items: [item(2)], nextCursor: null }));
    expect(result.current.state).toMatchObject({ more: 'idle', hasMore: false });
  });

  it('un fallo de la primera página se muestra y se puede reintentar', async () => {
    listMock
      .mockRejectedValueOnce(new WatchedApiError('server', 'No pudimos cargar tu historial.'))
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: null });

    const { result } = render();

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: 'error',
        message: 'No pudimos cargar tu historial.',
        expired: false,
      }),
    );

    act(() => result.current.retry());
    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(1)] }));
  });

  it('un 401 marca la sesión como vencida', async () => {
    listMock.mockRejectedValueOnce(new WatchedApiError('unauthorized', 'La sesión venció.'));

    const { result } = render();

    await waitFor(() => expect(result.current.state).toMatchObject({ expired: true }));
  });

  it('un fallo de la página siguiente conserva la lista y el cursor para reintentar', async () => {
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockRejectedValueOnce(new WatchedApiError('network', 'Sin conexión.'))
      .mockResolvedValueOnce({ items: [item(2)], nextCursor: null });

    const { result } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: 'ready',
        items: [item(1)],
        hasMore: true,
        more: 'error',
        moreError: 'Sin conexión.',
      }),
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state).toMatchObject({ hasMore: false }));
    expect(listMock).toHaveBeenLastCalledWith(TOKEN, {
      cursor: cursor(1),
      signal: expect.any(AbortSignal),
    });
  });

  it('al cambiar de usuario descarta la respuesta de la sesión anterior', async () => {
    const deA = deferred();
    listMock
      .mockReturnValueOnce(deA.promise)
      .mockResolvedValueOnce({ items: [item(9)], nextCursor: null });

    const { result, rerender } = render();

    rerender({ userId: USER_B, accessToken: 'token-b' });
    expect(signalOf(0).aborted).toBe(true);
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(9)] }));

    // La respuesta de A llega tarde: no pisa la lista de B.
    await act(async () => deA.resolve({ items: [item(1)], nextCursor: null }));
    expect(result.current.state).toMatchObject({ items: [item(9)] });
    expect(listMock).toHaveBeenLastCalledWith('token-b', { signal: expect.any(AbortSignal) });
  });

  it('nunca muestra la lista del usuario anterior mientras carga la del nuevo', async () => {
    const deB = deferred();
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockReturnValueOnce(deB.promise);

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ userId: USER_B, accessToken: 'token-b' });
    expect(result.current.state).toEqual({ status: 'loading' });

    // Tampoco se puede pedir la página siguiente con el cursor de A.
    act(() => result.current.loadMore());
    expect(listMock).toHaveBeenCalledTimes(2);

    await act(async () => deB.resolve({ items: [item(7)], nextCursor: null }));
    expect(result.current.state).toMatchObject({ items: [item(7)] });
  });

  it('al cambiar de usuario cancela la página siguiente en camino y la descarta', async () => {
    const siguiente = deferred();
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockReturnValueOnce(siguiente.promise)
      .mockResolvedValueOnce({ items: [item(9)], nextCursor: null });

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.loadMore());

    rerender({ userId: USER_B, accessToken: 'token-b' });
    expect(signalOf(1).aborted).toBe(true);
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(9)] }));

    await act(async () => siguiente.resolve({ items: [item(2)], nextCursor: null }));
    expect(result.current.state).toMatchObject({ items: [item(9)], hasMore: false });
  });

  it('renovar el token conserva la lista y pide la página siguiente con el token nuevo', async () => {
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockResolvedValueOnce({ items: [item(2)], nextCursor: null });

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ userId: USER_A, accessToken: 'token-renovado' });
    expect(result.current.state).toMatchObject({ items: [item(1)] });
    expect(listMock).toHaveBeenCalledTimes(1);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state).toMatchObject({ hasMore: false }));
    expect(listMock).toHaveBeenLastCalledWith('token-renovado', {
      cursor: cursor(1),
      signal: expect.any(AbortSignal),
    });
  });

  it('renovar el token mientras carga la primera página descarta un 401 tardío del token viejo', async () => {
    const vieja = deferred();
    listMock
      .mockReturnValueOnce(vieja.promise)
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: null });

    const { result, rerender } = render();

    rerender({ userId: USER_A, accessToken: 'token-renovado' });
    expect(signalOf(0).aborted).toBe(true);
    expect(listMock).toHaveBeenLastCalledWith('token-renovado', {
      signal: expect.any(AbortSignal),
    });
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(1)] }));

    await act(async () => vieja.reject(new WatchedApiError('unauthorized', 'La sesión venció.')));
    expect(result.current.state).toMatchObject({ status: 'ready', items: [item(1)] });
  });

  it('A → B → A no recupera la lista ni el cursor anteriores de A', async () => {
    const deA = deferred();
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockResolvedValueOnce({ items: [item(9)], nextCursor: null })
      .mockReturnValueOnce(deA.promise);

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(1)] }));

    rerender({ userId: USER_B, accessToken: 'token-b' });
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(9)] }));

    rerender({ userId: USER_A, accessToken: TOKEN });
    expect(result.current.state).toEqual({ status: 'loading' });
    expect(listMock).toHaveBeenLastCalledWith(TOKEN, { signal: expect.any(AbortSignal) });

    // El cursor viejo de A no sirve para pedir más mientras llega la consulta nueva.
    act(() => result.current.loadMore());
    expect(listMock).toHaveBeenCalledTimes(3);

    await act(async () => deA.resolve({ items: [item(2)], nextCursor: null }));
    expect(result.current.state).toMatchObject({ items: [item(2)], hasMore: false });
  });

  it('volver a A antes de que cargue B vuelve a pedir la primera página de A', async () => {
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: null })
      .mockReturnValueOnce(deferred().promise)
      .mockResolvedValueOnce({ items: [item(3)], nextCursor: null });

    const { result, rerender } = render();
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(1)] }));

    rerender({ userId: USER_B, accessToken: 'token-b' });
    rerender({ userId: USER_A, accessToken: TOKEN });

    expect(listMock).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [item(3)] }));
  });

  it('reintentar tras un 401 de la página siguiente vuelve a pedir la primera', async () => {
    listMock
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: cursor(1) })
      .mockRejectedValueOnce(new WatchedApiError('unauthorized', 'La sesión venció.'))
      .mockResolvedValueOnce({ items: [item(1)], nextCursor: null });

    const { result } = render();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state).toMatchObject({ expired: true }));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state).toMatchObject({ hasMore: false }));
    expect(listMock).toHaveBeenLastCalledWith(TOKEN, { signal: expect.any(AbortSignal) });
  });

  it('desmontar cancela la consulta en curso', async () => {
    listMock.mockReturnValueOnce(deferred().promise);

    const { unmount } = render();
    unmount();

    expect(signalOf(0).aborted).toBe(true);
  });
});
