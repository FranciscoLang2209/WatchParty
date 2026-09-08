import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { AppLayout } from '@/layouts/AppLayout';
import { AuthPage } from '@/features/auth/AuthPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { HomePage } from '@/features/home/HomePage';
import { MatchDetailPage } from '@/features/matches/MatchDetailPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/matches/:matchId" element={<MatchDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
