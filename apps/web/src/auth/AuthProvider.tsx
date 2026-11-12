import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { RECOVERY_LINK_WAIT_MS, recoveryLinkInUrl } from './recovery-link';
import {
  AuthContext,
  type AuthStatus,
  type SignOutOptions,
  type SignOutResult,
} from './auth-context';

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [signedOutExplicitly, setSignedOutExplicitly] = useState(false);
  // La URL trajo un enlace de recuperación con sesión y todavía no llegó `PASSWORD_RECOVERY`.
  const [awaitingRecovery, setAwaitingRecovery] = useState(recoveryLinkInUrl);

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;

      setSession(data.session);
      setStatus(data.session ? 'authenticated' : 'unauthenticated');

      // Sin sesión el enlace no sirvió (vencido, ya usado…): no hay señal que esperar.
      if (!data.session) setAwaitingRecovery(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;

      setSession(nextSession);
      setStatus(nextSession ? 'authenticated' : 'unauthenticated');

      if (nextSession) {
        setSignedOutExplicitly(false);
      }

      // El enlace del correo llega como `PASSWORD_RECOVERY`: es la única señal
      // que habilita el cambio. Se sostiene mientras dure esa sesión —
      // `TOKEN_REFRESHED` no puede expulsar a quien está completando el
      // formulario — y se apaga en cuanto la sesión desaparece.
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecovering(true);
        setAwaitingRecovery(false);
      } else if (!nextSession) {
        setIsRecovering(false);
        setAwaitingRecovery(false);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // Con un enlace de recuperación, el cliente guarda la sesión y recién después emite
  // `PASSWORD_RECOVERY`. En ese hueco hay sesión pero todavía no hay permiso para cambiar la
  // contraseña: se espera la señal, con un tope corto por si no llega. El tope corre desde que
  // la sesión se resolvió, no desde el montaje: una red lenta no lo agota antes de tiempo.
  useEffect(() => {
    if (!awaitingRecovery || status !== 'authenticated') return;

    const timer = setTimeout(() => setAwaitingRecovery(false), RECOVERY_LINK_WAIT_MS);

    return () => clearTimeout(timer);
  }, [awaitingRecovery, status]);

  const signOut = useCallback(async (options?: SignOutOptions): Promise<SignOutResult> => {
    setIsSigningOut(true);
    // Se marca antes de llamar a Supabase: emite `SIGNED_OUT` antes de que
    // `signOut()` resuelva, y el guard tiene que ver la marca al redirigir.
    setSignedOutExplicitly(options?.explicit === true);

    try {
      const { error } = await supabase.auth.signOut();

      // Aunque falle el `POST /logout`, el cliente ya borró la sesión local y
      // emitió `SIGNED_OUT`: la marca se mantiene y se apaga al volver a entrar.
      if (error) {
        return { error: 'No pudimos cerrar la sesión. Intentá de nuevo.' };
      }

      setSession(null);
      setStatus('unauthenticated');
      setIsRecovering(false);

      return { error: null };
    } finally {
      setIsSigningOut(false);
    }
  }, []);

  const endRecovery = useCallback(() => {
    setIsRecovering(false);
  }, []);

  // Mientras se espera la señal de recuperación sigue «cargando»: ni se afirma que el enlace es
  // inválido ni se deja pasar a una sesión que todavía no está autorizada a cambiar la contraseña.
  const exposedStatus: AuthStatus =
    awaitingRecovery && status === 'authenticated' && !isRecovering ? 'loading' : status;

  const value = useMemo(
    () => ({
      status: exposedStatus,
      session,
      user: session?.user ?? null,
      signOut,
      isSigningOut,
      signedOutExplicitly,
      isRecovering,
      endRecovery,
    }),
    [exposedStatus, session, signOut, isSigningOut, signedOutExplicitly, isRecovering, endRecovery],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
