import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const { authMock, fromMock } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() },
  fromMock: vi.fn(),
}));

// Se mockea por el alias para comprobar de paso que `@/*` resuelve en los tests.
vi.mock('@/lib/supabase', () => ({ supabase: { auth: authMock, from: fromMock } }));

const { AuthProvider } = await import('@/auth/AuthProvider');
const { AppRoutes } = await import('@/app/router');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

let fetchSpy: ReturnType<typeof vi.spyOn>;

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
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('HomePage', () => {
  it('se monta en / con una sesión válida', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });

  it('expone un único encabezado accesible «Inicio», oculto visualmente', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');

    const headings = await screen.findAllByRole('heading', { level: 1 });

    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAccessibleName('Inicio');
    expect(headings[0]).toHaveClass('sr-only');
  });

  it('redirige a /login a una persona sin sesión', async () => {
    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Inicio' })).not.toBeInTheDocument();
  });

  it('no muestra la Home mientras la sesión se está restaurando', () => {
    authMock.getSession.mockReturnValue(new Promise(() => {}));

    renderAt('/');

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Inicio' })).not.toBeInTheDocument();
  });

  it('no contiene datos de partidos ni contenido simulado', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    const { container } = renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    const main = screen.getByRole('main');

    expect(main.textContent?.replace(/\s/g, '')).toBe('Inicio');
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/partido|bienvenid|vs\.?/i)).not.toBeInTheDocument();
  });

  it('no realiza llamadas HTTP ni consulta tablas de Supabase', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('no incorpora Header ni navegación', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('conserva las rutas públicas de acceso', async () => {
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('conserva la ruta pública de registro', async () => {
    renderAt('/register');
    expect(await screen.findByRole('heading', { name: 'Crear cuenta' })).toBeInTheDocument();
  });
});
