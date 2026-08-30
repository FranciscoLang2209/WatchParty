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

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;

      setSession(data.session);
      setStatus(data.session ? 'authenticated' : 'unauthenticated');
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;

      setSession(nextSession);
      setStatus(nextSession ? 'authenticated' : 'unauthenticated');
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

      return { error: null };
    } finally {
      setIsSigningOut(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      signOut,
      isSigningOut,
    }),
    [status, session, signOut, isSigningOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
