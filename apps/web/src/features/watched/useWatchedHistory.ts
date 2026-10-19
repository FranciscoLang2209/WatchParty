import { useCallback, useEffect, useRef, useState } from 'react';
import { listWatchedHistoryPage } from './api';
import {
  WatchedApiError,
  isCancelled,
  type WatchedHistoryCursor,
  type WatchedHistoryItem,
} from './types';

/** Lo que ve la pantalla del historial (WAT-219). */
export type WatchedHistoryState =
  | { status: 'loading' }
  | {
      status: 'ready';
      /** Del más reciente al más antiguo, sin partidos repetidos. */
      items: WatchedHistoryItem[];
      /** `false` cuando el servidor ya no informa página siguiente. */
      hasMore: boolean;
      /** Estado del pedido de la página siguiente. */
      more: 'idle' | 'loading' | 'error';
      /** Mensaje presentable del último fallo de la página siguiente. */
      moreError: string | null;
    }
  | { status: 'error'; message: string; expired: boolean };

export interface UseWatchedHistory {
  state: WatchedHistoryState;
  /** Pide la página siguiente. No hace nada si no hay más o ya hay una en camino. */
  loadMore: () => void;
  /** Vuelve a pedir la primera página tras un fallo. */
  retry: () => void;
}

/** Estado interno: cada resultado recuerda de qué usuario es. */
type Estado =
  | { status: 'loading' }
  | {
      status: 'ready';
      userId: string;
      items: WatchedHistoryItem[];
      nextCursor: WatchedHistoryCursor | null;
      more: 'idle' | 'loading' | 'error';
      moreError: string | null;
    }
  | { status: 'error'; userId: string; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar tu historial. Intentá de nuevo.';

function toFallo(error: unknown): { message: string; expired: boolean } {
  if (error instanceof WatchedApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Agrega una página al final sin repetir partidos. Cada página es
 * estrictamente anterior a la previa, así que no se reordena: sólo se descarta
 * lo que ya estaba (por `match.id`), conservando su lugar.
 */
function agregarPagina(
  current: readonly WatchedHistoryItem[],
  incoming: readonly WatchedHistoryItem[],
): WatchedHistoryItem[] {
  const vistos = new Set(current.map((item) => item.match.id));
  const nuevos: WatchedHistoryItem[] = [];

  for (const item of incoming) {
    if (vistos.has(item.match.id)) continue;

    vistos.add(item.match.id);
    nuevos.push(item);
  }

  return [...current, ...nuevos];
}

/**
 * Historial propio de partidos vistos, paginado (WAT-218). Sólo habla con la
 * Node API con el bearer de la sesión: nunca consulta Supabase directo.
 *
 * Pide la primera página al montarse y cada vez que cambia `userId`. Cambiar
 * de usuario descarta todo lo anterior —lista, cursor y respuestas en
 * camino—, aunque se vuelva a un usuario ya visto: su estado viejo no
 * reaparece. Renovar el token mientras carga la primera página la vuelve a
 * pedir con el token nuevo y descarta la del viejo (p. ej. un 401 tardío);
 * renovarlo con la lista ya cargada la conserva, y la página siguiente se
 * pide con el token vigente. Sin sesión no pide nada.
 */
export function useWatchedHistory(
  userId: string | null,
  accessToken: string | null,
): UseWatchedHistory {
  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  const [usuarioPrevio, setUsuarioPrevio] = useState(userId);
  // Usuario cuya primera página ya llegó: renovar el token no la vuelve a pedir.
  const cargada = useRef<string | null>(null);
  // Hay un pedido de página en curso: bloquea un segundo pedido aunque todavía
  // no se haya vuelto a renderizar.
  const cargandoMas = useRef(false);
  const pedidoDeMas = useRef<AbortController | null>(null);

  // Cambiar de usuario invalida el estado en el mismo render, antes de que se
  // pueda mostrar o usar su cursor: ni siquiera vuelve el de un usuario previo.
  if (usuarioPrevio !== userId) {
    setUsuarioPrevio(userId);
    setEstado({ status: 'loading' });
  }

  useEffect(() => {
    if (userId === null || accessToken === null || cargada.current === userId) return;

    const controller = new AbortController();

    listWatchedHistoryPage(accessToken, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;

        cargada.current = userId;
        setEstado({
          status: 'ready',
          userId,
          items: agregarPagina([], page.items),
          nextCursor: page.nextCursor,
          more: 'idle',
          moreError: null,
        });
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje, cambio de usuario o
        // renovación del token no se anuncia.
        if (controller.signal.aborted || isCancelled(error)) return;

        setEstado({ status: 'error', userId, ...toFallo(error) });
      });

    return () => controller.abort();
  }, [userId, accessToken, intento]);

  // Al salir, cambiar de usuario o renovarse el token se cancela la página que
  // estuviera en camino: su respuesta (p. ej. un 401 del token viejo) ya no
  // vale. La acción queda libre para volver a pedirla con el token nuevo.
  useEffect(
    () => () => {
      if (!pedidoDeMas.current) return;

      pedidoDeMas.current.abort();
      pedidoDeMas.current = null;
      cargandoMas.current = false;
      setEstado((previo) =>
        previo.status === 'ready' && previo.more === 'loading'
          ? { ...previo, more: 'idle' }
          : previo,
      );
    },
    [userId, accessToken],
  );

  // Volver a un usuario anterior (A → B → A) pide su primera página de nuevo.
  useEffect(
    () => () => {
      cargada.current = null;
    },
    [userId],
  );

  const retry = useCallback(() => {
    // Un 401 de la página siguiente también se reintenta desde la primera.
    cargada.current = null;
    setIntento((valor) => valor + 1);
    setEstado({ status: 'loading' });
  }, []);

  const loadMore = useCallback(() => {
    if (
      estado.status !== 'ready' ||
      estado.userId !== userId ||
      estado.nextCursor === null ||
      accessToken === null ||
      cargandoMas.current
    ) {
      return;
    }

    const cursor = estado.nextCursor;
    const usuario = estado.userId;
    const controller = new AbortController();

    cargandoMas.current = true;
    pedidoDeMas.current = controller;
    setEstado((previo) =>
      previo.status === 'ready' && previo.nextCursor === cursor
        ? { ...previo, more: 'loading', moreError: null }
        : previo,
    );

    listWatchedHistoryPage(accessToken, { cursor, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;

        setEstado((previo) =>
          previo.status === 'ready' && previo.userId === usuario && previo.nextCursor === cursor
            ? {
                ...previo,
                items: agregarPagina(previo.items, page.items),
                nextCursor: page.nextCursor,
                more: 'idle',
              }
            : previo,
        );
      })
      .catch((error: unknown) => {
        // Un pedido cancelado no se anuncia, aunque su error haya llegado
        // después de cancelarlo.
        if (controller.signal.aborted || isCancelled(error)) return;

        const fallo = toFallo(error);

        // El fallo conserva la lista y el cursor para reintentar, salvo que la
        // sesión haya vencido: ahí hace falta ofrecer el reingreso.
        setEstado((previo) => {
          if (previo.status !== 'ready' || previo.userId !== usuario) return previo;
          if (fallo.expired) return { status: 'error', userId: usuario, ...fallo };

          return previo.nextCursor === cursor
            ? { ...previo, more: 'error', moreError: fallo.message }
            : previo;
        });
      })
      .finally(() => {
        if (pedidoDeMas.current !== controller) return;

        pedidoDeMas.current = null;
        cargandoMas.current = false;
      });
  }, [estado, userId, accessToken]);

  return { state: toState(estado, userId), loadMore, retry };
}

/** Lo que no es del usuario actual se presenta como carga, nunca como suyo. */
function toState(estado: Estado, userId: string | null): WatchedHistoryState {
  if (estado.status === 'loading' || estado.userId !== userId) return { status: 'loading' };

  if (estado.status === 'error') {
    return { status: 'error', message: estado.message, expired: estado.expired };
  }

  return {
    status: 'ready',
    items: estado.items,
    hasMore: estado.nextCursor !== null,
    more: estado.more,
    moreError: estado.moreError,
  };
}
