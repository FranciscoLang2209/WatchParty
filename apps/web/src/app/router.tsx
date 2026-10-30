import { Navigate, Route, Routes, useMatch } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { useAuth } from '@/auth/useAuth';
import { AppLayout } from '@/layouts/AppLayout';
import { AuthPage } from '@/features/auth/AuthPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { HomePage } from '@/features/home/HomePage';
import { LandingPage } from '@/features/landing/LandingPage';
import { MatchDetailPage } from '@/features/matches/MatchDetailPage';
import { ProfilePage } from '@/features/profiles/ProfilePage';
import { RoomPage } from '@/features/rooms/RoomPage';
import { RoomsDirectoryPage } from '@/features/rooms/RoomsDirectoryPage';
import { SearchPage } from '@/features/search/SearchPage';

/**
 * Área privada con una excepción: `/` sin sesión muestra la landing en lugar de
 * redirigir a `/login`. Mientras la sesión se restaura manda `RequireAuth`, así
 * que la landing nunca aparece antes de saber si hay sesión.
 */
function PrivateAreaOrLanding() {
  const { status } = useAuth();
  const isRoot = useMatch('/') !== null;

  if (isRoot && status === 'unauthenticated') {
    return <LandingPage />;
  }

  return (
    <RequireAuth>
      <AppLayout />
    </RequireAuth>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<PrivateAreaOrLanding />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/matches/:matchId" element={<MatchDetailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/rooms" element={<RoomsDirectoryPage />} />
        <Route path="/rooms/:roomId" element={<RoomPage />} />
        <Route path="/search" element={<SearchPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
