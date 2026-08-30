import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('../lib/supabase', () => ({ supabase: { auth: authMock } }));

const { AuthProvider } = await import('../auth/AuthProvider');
const { AppRoutes } = await import('./router');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

describe('AppRoutes', () => {
  it('expone /login como ruta pública', async () => {
    renderAt('/login');

    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('expone /register como ruta pública', async () => {
    renderAt('/register');

    expect(await screen.findByRole('heading', { name: 'Crear cuenta' })).toBeInTheDocument();
  });

  it('redirige Home a /login sin sesión', async () => {
    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('redirige el detalle de partido a /login sin sesión', async () => {
    renderAt('/matches/match-001');

    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('renderiza Home dentro del layout privado con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('renderiza el detalle de partido con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/matches/match-001');

    expect(await screen.findByRole('heading', { name: 'Detalle del partido' })).toBeInTheDocument();
  });
});
