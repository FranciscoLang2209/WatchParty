import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './useAuth';

interface RequireAuthProps {
  children: ReactNode;
}

/**
 * Guard de rutas privadas: mientras la sesión se restaura no se renderiza el
 * contenido protegido, y sin sesión se redirige a `/login`. La ruta pedida
 * viaja en `state.from` para volver a ella después del login, salvo que la
 * persona haya cerrado sesión a propósito.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const { status, signedOutExplicitly } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <p role="status" aria-live="polite">
        Cargando sesión…
      </p>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <Navigate to="/login" replace state={signedOutExplicitly ? undefined : { from: location }} />
    );
  }

  return <>{children}</>;
}
