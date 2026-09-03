import { render, screen, within } from '@testing-library/react';
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

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
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

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    // El lienzo privado es la región principal; el Header vive fuera de ella.
    const main = within(screen.getByRole('main'));

    expect(screen.getByRole('main').textContent?.replace(/\s/g, '')).toBe('Inicio');
    expect(screen.getByRole('main').querySelectorAll('img')).toHaveLength(0);
    expect(main.queryByRole('list')).not.toBeInTheDocument();
    expect(main.queryByRole('button')).not.toBeInTheDocument();
    expect(main.queryByText(/partido|bienvenid|vs\.?/i)).not.toBeInTheDocument();
  });

  it('no realiza llamadas HTTP ni consulta tablas de Supabase', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('la Home no aporta Header ni navegación propios', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    // El Header lo monta AppLayout, no la página: dentro de main no hay ninguno.
    const main = within(screen.getByRole('main'));

    expect(main.queryByRole('banner')).not.toBeInTheDocument();
    expect(main.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('conserva las rutas públicas de acceso', async () => {
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('conserva la ruta pública de registro', async () => {
    renderAt('/register');
    expect(await screen.findByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();
  });
});
