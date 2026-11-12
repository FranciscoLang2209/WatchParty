/**
 * Cuánto se espera, como máximo, la señal `PASSWORD_RECOVERY` cuando la URL trajo un enlace de
 * recuperación con sesión. Normalmente llega a los pocos milisegundos de resolverse la sesión;
 * el tope sólo evita dejar la pantalla en «Verificando…» si por algún motivo no llega.
 */
export const RECOVERY_LINK_WAIT_MS = 2000;

/**
 * ¿El fragmento de la URL es el de un enlace de recuperación con sesión (`type=recovery` y
 * tokens)? Un enlace vencido o inválido llega con `error=…` y sin tokens: no cuenta.
 */
export function hashHasRecoveryLink(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));

  return params.get('type') === 'recovery' && params.has('access_token');
}

/**
 * Se calcula al cargar el módulo, antes de que el cliente de Supabase procese la URL: en cuanto
 * lo hace, borra los tokens del fragmento y ya no queda rastro de que era un enlace de
 * recuperación. Se evalúa una sola vez; no cambia aunque la URL cambie después.
 */
export const recoveryLinkInUrl: boolean =
  typeof window !== 'undefined' && hashHasRecoveryLink(window.location.hash);
