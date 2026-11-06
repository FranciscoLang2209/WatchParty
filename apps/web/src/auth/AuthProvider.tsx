import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
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

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;

      setSession(data.session);
      setStatus(data.session ? 'authenticated' : 'unauthenticated');
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
      } else if (!nextSession) {
        setIsRecovering(false);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

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

  const value = useMemo(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      signOut,
      isSigningOut,
      signedOutExplicitly,
      isRecovering,
      endRecovery,
    }),
    [status, session, signOut, isSigningOut, signedOutExplicitly, isRecovering, endRecovery],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
