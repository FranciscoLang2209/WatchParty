import { beforeEach, describe, expect, it } from 'vitest';
import {
  REMEMBER_SESSION_KEY,
  rememberAwareStorage,
  setRememberSession,
  shouldRememberSession,
} from './session-storage';

const SESSION_KEY = 'sb-auth-token';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Preferencia de «Recordarme»', () => {
  it('recuerda por defecto cuando nunca se eligió', () => {
    expect(shouldRememberSession()).toBe(true);
  });

  it('persiste la elección en localStorage, que es del dispositivo', () => {
    setRememberSession(false);

    expect(window.localStorage.getItem(REMEMBER_SESSION_KEY)).toBe('false');
    expect(shouldRememberSession()).toBe(false);

    setRememberSession(true);
    expect(shouldRememberSession()).toBe(true);
  });
});

describe('Almacenamiento de la sesión según la preferencia', () => {
  it('con «Recordarme» escribe en localStorage y sobrevive al cierre', () => {
    setRememberSession(true);
    rememberAwareStorage.setItem(SESSION_KEY, 'sesion');

    expect(window.localStorage.getItem(SESSION_KEY)).toBe('sesion');
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('sin «Recordarme» escribe en sessionStorage y muere con la pestaña', () => {
    setRememberSession(false);
    rememberAwareStorage.setItem(SESSION_KEY, 'sesion');

    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('sesion');
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('al cambiar de preferencia no deja dos sesiones conviviendo', () => {
    setRememberSession(true);
    rememberAwareStorage.setItem(SESSION_KEY, 'vieja');

    setRememberSession(false);
    rememberAwareStorage.setItem(SESSION_KEY, 'nueva');

    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('nueva');
    expect(rememberAwareStorage.getItem(SESSION_KEY)).toBe('nueva');
  });

  it('lee la sesión esté donde esté', () => {
    window.sessionStorage.setItem(SESSION_KEY, 'desde-session');
    expect(rememberAwareStorage.getItem(SESSION_KEY)).toBe('desde-session');

    window.localStorage.setItem(SESSION_KEY, 'desde-local');
    expect(rememberAwareStorage.getItem(SESSION_KEY)).toBe('desde-local');
  });

  it('cerrar sesión borra de los dos stores', () => {
    window.localStorage.setItem(SESSION_KEY, 'a');
    window.sessionStorage.setItem(SESSION_KEY, 'b');

    rememberAwareStorage.removeItem(SESSION_KEY);

    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
