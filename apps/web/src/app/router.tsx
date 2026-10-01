import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { AppLayout } from '@/layouts/AppLayout';
import { AuthPage } from '@/features/auth/AuthPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { HomePage } from '@/features/home/HomePage';
import { MatchDetailPage } from '@/features/matches/MatchDetailPage';
import { ProfilePage } from '@/features/profiles/ProfilePage';
import { RoomPage } from '@/features/rooms/RoomPage';
import { RoomsDirectoryPage } from '@/features/rooms/RoomsDirectoryPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/matches/:matchId" element={<MatchDetailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/rooms" element={<RoomsDirectoryPage />} />
        <Route path="/rooms/:roomId" element={<RoomPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
