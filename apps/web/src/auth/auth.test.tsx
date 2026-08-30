import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

const { authMock, unsubscribe } = vi.hoisted(() => ({
  authMock: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
  unsubscribe: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({ supabase: { auth: authMock } }));

const { AuthProvider } = await import('./AuthProvider');
const { RequireAuth } = await import('./RequireAuth');
const { useAuth } = await import('./useAuth');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

let emitAuthChange: (event: AuthChangeEvent, session: Session | null) => void;

function renderApp() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/login" element={<h1>Iniciar sesión</h1>} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <h1>Inicio</h1>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.onAuthStateChange.mockImplementation(
    (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
      emitAuthChange = callback;
      return { data: { subscription: { unsubscribe } } };
    },
  );
});

describe('AuthProvider y RequireAuth', () => {
  it('no renderiza la ruta privada mientras la sesión se está restaurando', () => {
    authMock.getSession.mockReturnValue(new Promise(() => {}));

    renderApp();

    expect(screen.getByRole('status')).toHaveTextContent('Cargando sesión…');
    expect(screen.queryByRole('heading', { name: 'Inicio' })).not.toBeInTheDocument();
  });

  it('redirige a /login cuando no hay sesión', async () => {
    renderApp();

    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Inicio' })).not.toBeInTheDocument();
  });

  it('restaura una sesión existente al cargar y permite navegar la ruta privada', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderApp();

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
  });

  it('actualiza el estado de React ante un cambio de sesión de Supabase', async () => {
    function StatusProbe() {
      const { status, user } = useAuth();

      return <span data-testid="status">{`${status}:${user?.email ?? 'sin sesión'}`}</span>;
    }

    render(
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated:sin sesión'),
    );

    act(() => {
      emitAuthChange('SIGNED_IN', session);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated:a@b.com');

    act(() => {
      emitAuthChange('SIGNED_OUT', null);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated:sin sesión');
  });

  it('cancela la suscripción de Supabase al desmontar', async () => {
    const { unmount } = renderApp();

    await screen.findByRole('heading', { name: 'Iniciar sesión' });
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('expone el único flujo público de cierre de sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    function SignOutProbe() {
      const { signOut, isSigningOut, user } = useAuth();

      return (
        <div>
          <span data-testid="email">{user?.email ?? 'sin sesión'}</span>
          <button type="button" onClick={() => void signOut()} disabled={isSigningOut}>
            Cerrar sesión
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <SignOutProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('a@b.com'));

    await act(async () => {
      screen.getByRole('button', { name: 'Cerrar sesión' }).click();
    });

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('email')).toHaveTextContent('sin sesión');
  });
});
