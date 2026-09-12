import { createContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface SignOutResult {
  error: string | null;
}

export interface AuthContextValue {
  /** `loading` mientras se restaura la sesión persistida; nunca se renderiza contenido privado en ese estado. */
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  /** Único flujo público de cierre de sesión de la aplicación. */
  signOut: () => Promise<SignOutResult>;
  isSigningOut: boolean;
  /**
   * Modo efímero que habilita el cambio de contraseña. Sólo lo enciende el
   * evento `PASSWORD_RECOVERY` de Supabase: una sesión común, por sí sola, no
   * autoriza a reemplazar la contraseña.
   */
  isRecovering: boolean;
  /** Apaga el modo recuperación. Se llama al terminar el cambio. */
  endRecovery: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
