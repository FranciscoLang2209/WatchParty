import { Outlet } from 'react-router-dom';

/**
 * Layout del área autenticada. El Header y la navegación inferior se montan
 * aquí en tickets posteriores.
 */
export function AppLayout() {
  return (
    <div className="flex min-h-dvh w-full flex-col overflow-x-hidden">
      <main id="main-content" tabIndex={-1} className="flex w-full flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
