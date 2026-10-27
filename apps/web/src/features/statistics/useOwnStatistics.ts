import { useCallback, useEffect, useRef, useState } from 'react';
import { getOwnStatistics } from './api';
import { StatisticsApiError, isCancelled, type UserStatistics } from './types';

/** Lo que ve el resumen de actividad del perfil (WAT-233). */
export type OwnStatisticsState =
  | { status: 'loading' }
  | { status: 'ready'; statistics: UserStatistics }
  | { status: 'error'; message: string; expired: boolean };

export interface UseOwnStatistics {
  state: OwnStatisticsState;
  /** Vuelve a pedir los totales tras un fallo. */
  retry: () => void;
}

/** Estado interno: cada resultado recuerda de qué usuario es. */
type Estado =
  | { status: 'loading' }
  | { status: 'ready'; userId: string; statistics: UserStatistics }
  | { status: 'error'; userId: string; message: string; expired: boolean };

const MENSAJE_INESPERADO = 'No pudimos cargar tu actividad. Intentá de nuevo.';

function toFallo(error: unknown): { message: string; expired: boolean } {
  if (error instanceof StatisticsApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Totales propios del usuario autenticado (WAT-232), desde la Node API con el
 * bearer de la sesión.
 *
 * Pide al montarse —cada entrada al perfil vuelve a consultar— y cada vez que
 * cambia `userId`. Cambiar de usuario descarta el resultado anterior y la
 * respuesta en camino: los totales de otra sesión nunca se muestran. Renovar
 * el token mientras carga vuelve a pedir con el nuevo y descarta la del viejo
 * (p. ej. un 401 tardío); renovarlo con los totales ya cargados los conserva.
 * Sin sesión no pide nada.
 */
export function useOwnStatistics(
  userId: string | null,
  accessToken: string | null,
): UseOwnStatistics {
  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  // Usuario cuyos totales ya llegaron: renovar el token no los vuelve a pedir.
  const cargada = useRef<string | null>(null);
  const [usuarioPrevio, setUsuarioPrevio] = useState(userId);

  // Cambiar de usuario invalida el estado en el mismo render: ni siquiera
  // vuelven los totales viejos de un usuario previo (A → B → A).
  if (usuarioPrevio !== userId) {
    setUsuarioPrevio(userId);
    setEstado({ status: 'loading' });
  }

  useEffect(() => {
    if (userId === null || accessToken === null || cargada.current === userId) return;

    const controller = new AbortController();

    getOwnStatistics(accessToken, controller.signal)
      .then((statistics) => {
        if (controller.signal.aborted) return;

        cargada.current = userId;
        setEstado({ status: 'ready', userId, statistics });
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje, cambio de usuario o
        // renovación del token no se anuncia.
        if (controller.signal.aborted || isCancelled(error)) return;

        setEstado({ status: 'error', userId, ...toFallo(error) });
      });

    return () => controller.abort();
  }, [userId, accessToken, intento]);

  // Volver a un usuario anterior (A → B → A) pide sus totales de nuevo.
  useEffect(
    () => () => {
      cargada.current = null;
    },
    [userId],
  );

  const retry = useCallback(() => {
    cargada.current = null;
    setIntento((valor) => valor + 1);
    setEstado({ status: 'loading' });
  }, []);

  return { state: toState(estado, userId), retry };
}

/** Lo que no es del usuario actual se presenta como carga, nunca como suyo. */
function toState(estado: Estado, userId: string | null): OwnStatisticsState {
  if (estado.status === 'loading' || estado.userId !== userId) return { status: 'loading' };

  if (estado.status === 'error') {
    return { status: 'error', message: estado.message, expired: estado.expired };
  }

  return { status: 'ready', statistics: estado.statistics };
}
