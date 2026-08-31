import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../auth/RequireAuth';
import { AppLayout } from '../layouts/AppLayout';
import { AuthPage } from '../features/auth/AuthPage';

/**
 * Placeholders privados. Los tickets de Home y detalle los reemplazan por sus
 * páginas reales sin crear un router nuevo.
 */
function HomePlaceholder() {
  return <h1>Inicio</h1>;
}

function MatchDetailPlaceholder() {
  return <h1>Detalle del partido</h1>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
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
