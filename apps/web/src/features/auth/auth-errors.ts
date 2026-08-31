import type { AuthError } from '@supabase/supabase-js';
import type { AuthMode } from './auth-mode';

const GENERIC_MESSAGE = 'No pudimos completar la operación. Intentá de nuevo en unos instantes.';

/**
 * Traduce un error de Supabase Auth a un mensaje presentable.
 * Nunca se devuelven objetos, stack traces ni detalles internos del proveedor.
 */
export function toPresentableAuthError(error: AuthError, mode: AuthMode): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'El email o la contraseña no son correctos.';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Revisá el email ingresado.';
    case 'user_already_exists':
    case 'email_exists':
      return 'Ya existe una cuenta con ese email. Probá iniciar sesión.';
    case 'weak_password':
      return 'La contraseña es demasiado débil. Usá al menos 6 caracteres.';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Demasiados intentos. Esperá unos minutos y volvé a intentar.';
    case 'signup_disabled':
      return 'El registro no está disponible en este momento.';
    default:
      return mode === 'login' ? 'El email o la contraseña no son correctos.' : GENERIC_MESSAGE;
  }
}

export const MISSING_SESSION_MESSAGE: Record<AuthMode, string> = {
  login: 'No pudimos iniciar tu sesión. Intentá de nuevo.',
  register:
    'Creamos tu cuenta pero no pudimos iniciar la sesión automáticamente. Probá iniciar sesión.',
};
