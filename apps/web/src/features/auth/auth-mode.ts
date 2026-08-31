export type AuthMode = 'login' | 'register';

interface AuthCopy {
  title: string;
  description: string;
  submitLabel: string;
  pendingLabel: string;
  passwordAutoComplete: 'current-password' | 'new-password';
  switchPrompt: string;
  switchLabel: string;
  switchTo: string;
}

export const AUTH_COPY: Record<AuthMode, AuthCopy> = {
  login: {
    title: 'Iniciar sesión',
    description: 'Ingresá con tu email y contraseña para volver a WatchParty.',
    submitLabel: 'Iniciar sesión',
    pendingLabel: 'Ingresando…',
    passwordAutoComplete: 'current-password',
    switchPrompt: '¿No tenés cuenta?',
    switchLabel: 'Crear cuenta',
    switchTo: '/register',
  },
  register: {
    title: 'Crear cuenta',
    description: 'Creá tu cuenta con email y contraseña para empezar a mirar partidos.',
    submitLabel: 'Crear cuenta',
    pendingLabel: 'Creando cuenta…',
    passwordAutoComplete: 'new-password',
    switchPrompt: '¿Ya tenés cuenta?',
    switchLabel: 'Iniciar sesión',
    switchTo: '/login',
  },
};
