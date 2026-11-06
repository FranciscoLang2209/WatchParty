import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { setRememberSession } from '../../lib/session-storage';
import { AuthForm, type AuthCredentials } from './AuthForm';
import { AuthShell } from './AuthShell';
import { AUTH_COPY, PENDING_CONFIRMATION_MESSAGE, type AuthMode } from './auth-mode';
import { MISSING_SESSION_MESSAGE, toPresentableAuthError } from './auth-errors';

interface AuthPageProps {
  mode: AuthMode;
}

/**
 * `RequireAuth` deja en `state.from` la ruta privada que se pidió sin sesión.
 * Sólo se acepta una ruta interna (`/…`, nunca `//…`); cualquier otra cosa
 * vuelve al inicio.
 */
function redirectTarget(state: unknown): string {
  const from = (state as { from?: { pathname?: unknown; search?: unknown; hash?: unknown } } | null)
    ?.from;
  const pathname = from?.pathname;

  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return '/';
  }

  const search = typeof from?.search === 'string' ? from.search : '';
  const hash = typeof from?.hash === 'string' ? from.hash : '';

  return `${pathname}${search}${hash}`;
}

export function AuthPage({ mode }: AuthPageProps) {
  const copy = AUTH_COPY[mode];
  const navigate = useNavigate();
  const location = useLocation();
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  async function handleSubmit({ email, password, username, remember }: AuthCredentials) {
    // La preferencia se guarda antes de pedir la sesión: define en qué store la
    // va a escribir el cliente de Supabase.
    if (mode === 'login') {
      setRememberSession(remember ?? true);
    }

    const { data, error } =
      mode === 'register'
        ? // El nombre de usuario viaja como metadata del usuario: no requiere
          // tabla propia y queda disponible en la sesión.
          await supabase.auth.signUp({ email, password, options: { data: { username } } })
        : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      throw new Error(toPresentableAuthError(error, mode));
    }

    // Usuario sin sesión en el registro: el alta existe y espera la
    // confirmación por correo. Se reemplaza el formulario para que no se
    // reenvíe por error y vuelva a gastar el cupo de correos.
    if (!data.session && mode === 'register' && data.user) {
      setPendingConfirmation(true);
      return;
    }

    if (!data.session) {
      throw new Error(MISSING_SESSION_MESSAGE[mode]);
    }

    navigate(redirectTarget(location.state), { replace: true });
  }

  return (
    <AuthShell
      eyebrow={copy.eyebrow}
      title={copy.title}
      description={copy.description}
      footer={
        <>
          {copy.switchPrompt}{' '}
          <Link
            to={copy.switchTo}
            className="rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {copy.switchLabel}
          </Link>
        </>
      }
    >
      {pendingConfirmation ? (
        <div role="status" aria-live="polite" className="w-full">
          <p className="rounded-sm border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground">
            {PENDING_CONFIRMATION_MESSAGE}
          </p>
        </div>
      ) : (
        <AuthForm mode={mode} onSubmit={handleSubmit} />
      )}
    </AuthShell>
  );
}
