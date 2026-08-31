import { Outlet } from 'react-router-dom';
import { AppHeader } from '@/components/layout/AppHeader';

/**
 * Layout del área autenticada. La navegación inferior se monta aquí en el
 * ticket siguiente, después del contenido principal.
 */
export function AppLayout() {
  return (
    <div className="flex min-h-dvh w-full flex-col overflow-x-hidden">
      <AppHeader />
      <main id="main-content" tabIndex={-1} className="flex w-full flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
