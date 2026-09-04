/**
 * «Recordarme» decide dónde se guarda la sesión de Supabase:
 *
 * - marcado   → `localStorage`, la sesión sobrevive al cierre del navegador.
 * - sin marcar → `sessionStorage`, la sesión muere al cerrar la pestaña.
 *
 * La preferencia es del dispositivo, no de la cuenta, así que vive siempre en
 * `localStorage` aunque la sesión no lo haga.
 */
export const REMEMBER_SESSION_KEY = 'watchparty-remember-session';

/** Recordar es el comportamiento por defecto, como en el mockup. */
export function shouldRememberSession(): boolean {
  try {
    return window.localStorage.getItem(REMEMBER_SESSION_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setRememberSession(remember: boolean): void {
  try {
    window.localStorage.setItem(REMEMBER_SESSION_KEY, remember ? 'true' : 'false');
  } catch {
    // Un navegador con almacenamiento bloqueado no debe romper el login.
  }
}

/**
 * Adaptador de almacenamiento para Supabase Auth. Escribe en un único store
 * según la preferencia vigente y limpia el otro, para que nunca queden dos
 * sesiones conviviendo.
 */
export const rememberAwareStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },

  setItem(key: string, value: string): void {
    try {
      const [target, other] = shouldRememberSession()
        ? [window.localStorage, window.sessionStorage]
        : [window.sessionStorage, window.localStorage];

      target.setItem(key, value);
      other.removeItem(key);
    } catch {
      // Ídem: sin almacenamiento la sesión dura lo que dure la pestaña.
    }
  },

  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    } catch {
      // Ídem.
    }
  },
};
