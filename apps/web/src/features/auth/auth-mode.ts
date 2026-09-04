export type AuthMode = 'login' | 'register';

interface AuthCopy {
  /** Antetítulo corto sobre el título. Se muestra en mayúsculas por CSS. */
  eyebrow: string;
  title: string;
  description: string;
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
    description: 'Usá tu cuenta para volver a tus partidos y comunidades.',
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

/** Controles que sólo existen en el login. */
export const LOGIN_EXTRAS = {
  rememberLabel: 'Recordarme',
  forgotLabel: 'Olvidé mi contraseña',
  forgotTo: '/forgot-password',
} as const;

export const FORGOT_PASSWORD_COPY = {
  eyebrow: 'Recuperá tu acceso',
  title: '¿Olvidaste tu contraseña?',
  description: 'Ingresá tu correo y te mandamos un enlace para crear una nueva.',
  emailPlaceholder: 'nombre@ejemplo.com',
  submitLabel: 'Enviar enlace',
  pendingLabel: 'Enviando…',
  /**
   * No confirma ni desmiente que la cuenta exista: revelarlo permitiría
   * averiguar qué correos están registrados.
   */
  sentMessage:
    'Si existe una cuenta con ese correo, te enviamos un enlace para crear una contraseña nueva.',
  backPrompt: '¿Te acordaste?',
  backLabel: 'Ingresar',
  backTo: '/login',
} as const;
