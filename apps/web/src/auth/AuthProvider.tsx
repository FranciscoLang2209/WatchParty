import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { AuthContext, type AuthStatus, type SignOutResult } from './auth-context';

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);

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

  const signOut = useCallback(async (): Promise<SignOutResult> => {
    setIsSigningOut(true);

    try {
      const { error } = await supabase.auth.signOut();

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
      isRecovering,
      endRecovery,
    }),
    [status, session, signOut, isSigningOut, isRecovering, endRecovery],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
