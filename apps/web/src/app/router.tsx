import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../auth/RequireAuth';
import { AppLayout } from '../layouts/AppLayout';

/**
 * Placeholders públicos y privados. Los tickets de acceso, Home y detalle los
 * reemplazan por sus páginas reales sin crear un router nuevo.
 */
function LoginPlaceholder() {
  return <h1>Iniciar sesión</h1>;
}

function RegisterPlaceholder() {
  return <h1>Crear cuenta</h1>;
}

function HomePlaceholder() {
  return <h1>Inicio</h1>;
}

function MatchDetailPlaceholder() {
  return <h1>Detalle del partido</h1>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPlaceholder />} />
      <Route path="/register" element={<RegisterPlaceholder />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomePlaceholder />} />
        <Route path="/matches/:matchId" element={<MatchDetailPlaceholder />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
