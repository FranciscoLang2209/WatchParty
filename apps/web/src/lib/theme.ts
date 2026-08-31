export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'watchparty-theme';

export function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Un navegador con almacenamiento bloqueado no debe romper el cambio de tema.
  }
}

/** Preferencia del sistema, usada cuando la persona todavía no eligió. */
export function getSystemTheme(): Theme {
  if (typeof window.matchMedia !== 'function') return 'light';

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? getSystemTheme();
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;

  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}
