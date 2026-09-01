import { Outlet } from 'react-router-dom';
import { AppHeader } from '@/components/layout/AppHeader';
import { BottomNavigation } from '@/components/layout/BottomNavigation';

/** Layout del área autenticada. */
export function AppLayout() {
  return (
    <div className="flex min-h-dvh w-full flex-col overflow-x-hidden">
      <AppHeader />
      {/* El padding inferior reserva el espacio de la navegación móvil para que
          no cubra contenido ni controles; desde 981 px la barra no existe. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex w-full flex-1 flex-col pb-bottom-nav desktop:pb-0"
      >
        <Outlet />
      </main>
      <BottomNavigation />
    </div>
  );
}
