export type AuthMode = 'login' | 'register';

interface AuthCopy {
  /** Antetítulo corto sobre el título. Se muestra en mayúsculas por CSS. */
  eyebrow: string;
  title: string;
  /** El login del mockup no lleva bajada; el registro sí. */
  description?: string;
  emailPlaceholder: string;
  passwordPlaceholder: string;
  submitLabel: string;
  pendingLabel: string;
  passwordAutoComplete: 'current-password' | 'new-password';
  switchPrompt: string;
  switchLabel: string;
  switchTo: string;
}

export const AUTH_COPY: Record<AuthMode, AuthCopy> = {
  login: {
    eyebrow: 'Bienvenido de nuevo',
    title: 'Entrá a la tribuna',
    emailPlaceholder: 'nombre@ejemplo.com',
    passwordPlaceholder: 'Tu contraseña',
    submitLabel: 'Ingresar',
    pendingLabel: 'Ingresando…',
    passwordAutoComplete: 'current-password',
    switchPrompt: '¿Todavía no tenés cuenta?',
    switchLabel: 'Crear cuenta',
    switchTo: '/register',
  },
  register: {
    eyebrow: 'Creá tu cuenta',
    title: 'Sumate a la tribuna',
    description: 'Armá tu perfil para comentar, calificar y guardar cada partido.',
    emailPlaceholder: 'nombre@ejemplo.com',
    passwordPlaceholder: 'Mínimo 8 caracteres',
    submitLabel: 'Crear cuenta',
    pendingLabel: 'Creando cuenta…',
    passwordAutoComplete: 'new-password',
    switchPrompt: '¿Ya tenés una cuenta?',
    switchLabel: 'Ingresar',
    switchTo: '/login',
  },
};

/**
 * Campos que sólo existen en el registro. Viven acá para que el formulario no
 * declare copy propio.
 */
export const REGISTER_FIELDS = {
  usernameLabel: 'Usuario',
  usernamePlaceholder: 'Nombre de usuario',
  confirmPasswordLabel: 'Confirmar contraseña',
  confirmPasswordPlaceholder: 'Repetí tu contraseña',
} as const;

/** Coincide con el placeholder «Mínimo 8 caracteres» del registro. */
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_MISMATCH_MESSAGE = 'Las contraseñas no coinciden.';
