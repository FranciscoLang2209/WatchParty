import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { AppLayout } from '@/layouts/AppLayout';
import { AuthPage } from '@/features/auth/AuthPage';
import { HomePage } from '@/features/home/HomePage';

/**
 * Placeholder privado. El ticket de detalle lo reemplaza por su página real sin
 * crear un router nuevo.
 */
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
        <Route path="/" element={<HomePage />} />
        <Route path="/matches/:matchId" element={<MatchDetailPlaceholder />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
