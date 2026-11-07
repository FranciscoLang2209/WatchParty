import type { AuthError } from '@supabase/supabase-js';
import type { AuthMode } from './auth-mode';

const GENERIC_MESSAGE = 'No pudimos completar la operación. Intentá de nuevo en unos instantes.';
const NETWORK_MESSAGE = 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.';

/**
 * Traduce un error de Supabase Auth a un mensaje presentable.
 * Nunca se devuelven objetos, stack traces ni detalles internos del proveedor.
 */
export function toPresentableAuthError(error: AuthError, mode: AuthMode): string {
  // Ni la red caída ni un 5xx son culpa de las credenciales: decir que lo son
  // haría reintentar con otra clave. El cliente lanza `AuthRetryableFetchError`
  // en los dos casos, así que se distinguen por status: 0 es que no hubo
  // respuesta; un 5xx es que el servidor respondió con error, y pedir que se
  // revise la conexión sería otra pista falsa.
  if (error.status === 0) {
    return NETWORK_MESSAGE;
  }

  if (typeof error.status === 'number' && error.status >= 500) {
    return GENERIC_MESSAGE;
  }

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
    // Los dos límites responden 429, pero piden cosas distintas: el primero es
    // de la persona (frenar), el segundo es del envío de correos y reintentar
    // no lo destraba. Ninguno promete un plazo: el proveedor no lo informa.
    case 'over_request_rate_limit':
      return 'Hiciste demasiados intentos seguidos. Esperá un rato antes de volver a intentar.';
    case 'over_email_send_rate_limit':
      return 'Por ahora no podemos enviar correos de confirmación. Probá más tarde.';
    case 'email_not_confirmed':
      return 'Tu cuenta todavía no está confirmada. Revisá tu correo para confirmarla.';
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
