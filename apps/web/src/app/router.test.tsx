import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
    signInWithPassword: vi.fn(),
  },
}));

vi.mock('../lib/supabase', () => ({ supabase: { auth: authMock } }));
vi.mock('../lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: 'https://api.watchparty.test',
  }),
}));

const { AuthProvider } = await import('../auth/AuthProvider');
const { AppRoutes } = await import('./router');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

const partido = {
  id: 'match-001',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
};

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
  // Las rutas privadas consultan la Node API: se responde desde el test para no
  // dejar peticiones reales sueltas.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const path = String(url);

    const body = path.endsWith('/matches')
      ? { matches: [] }
      : path.endsWith('/me/profile')
        ? { profile: null }
        : path.endsWith('/teams')
          ? { teams: [] }
          : { match: partido };

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('AppRoutes', () => {
  it('expone /login como ruta pública', async () => {
    renderAt('/login');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('expone /forgot-password como ruta pública', async () => {
    renderAt('/forgot-password');

    expect(
      await screen.findByRole('heading', { name: '¿Olvidaste tu contraseña?' }),
    ).toBeInTheDocument();
  });

  it('expone /reset-password como ruta pública', async () => {
    renderAt('/reset-password');

    // Sin la señal de recuperación la pantalla no ofrece el formulario, pero la
    // ruta existe y no redirige al login.
    expect(await screen.findByRole('link', { name: 'Pedir un enlace nuevo' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Entrá a la tribuna' })).not.toBeInTheDocument();
  });

  it('expone /register como ruta pública', async () => {
    renderAt('/register');

    expect(await screen.findByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();
  });

  it('muestra la landing en / sin sesión, sin redirigir a /login', async () => {
    renderAt('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mirá el partido con tu tribuna' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Entrá a la tribuna' })).not.toBeInTheDocument();
    // La landing no monta el layout privado.
    expect(
      screen.queryByRole('navigation', { name: 'Navegación principal' }),
    ).not.toBeInTheDocument();
  });

  it('el CTA de registro de la landing lleva a /register', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(
      (await screen.findAllByRole('link', { name: 'Crear cuenta' }))[0] as HTMLElement,
    );
    expect(await screen.findByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();
  });

  it('el CTA de ingreso de la landing lleva a /login', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(await screen.findByRole('link', { name: 'Ya tengo cuenta' }));
    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('las rutas desconocidas sin sesión terminan en la landing', async () => {
    renderAt('/no-existe');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mirá el partido con tu tribuna' }),
    ).toBeInTheDocument();
  });

  it('mientras se restaura la sesión en / no muestra la landing ni redirige', async () => {
    let resolveSession: (value: {
      data: { session: Session | null };
      error: null;
    }) => void = () => {};
    authMock.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    renderAt('/');

    expect(screen.getByRole('status')).toHaveTextContent('Cargando sesión…');
    expect(
      screen.queryByRole('heading', { name: 'Mirá el partido con tu tribuna' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Entrá a la tribuna' })).not.toBeInTheDocument();

    await act(async () => {
      resolveSession({ data: { session }, error: null });
    });

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Mirá el partido con tu tribuna' }),
    ).not.toBeInTheDocument();
  });

  it('al cerrar sesión en / pasa de Home a la landing', async () => {
    let emit: (event: AuthChangeEvent, next: Session | null) => void = () => {};
    authMock.onAuthStateChange.mockImplementation((callback) => {
      emit = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();

    act(() => {
      emit('SIGNED_OUT', null);
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mirá el partido con tu tribuna' }),
    ).toBeInTheDocument();
  });

  it('redirige /profile a /login sin sesión', async () => {
    renderAt('/profile');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tu perfil' })).not.toBeInTheDocument();
  });

  it('redirige el detalle de partido a /login sin sesión', async () => {
    renderAt('/matches/match-001');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('redirige /rooms a /login sin sesión', async () => {
    renderAt('/rooms');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Salas' })).not.toBeInTheDocument();
  });

  it('redirige /search a /login sin sesión', async () => {
    renderAt('/search');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Buscar' })).not.toBeInTheDocument();
  });

  it('renderiza /search dentro del layout privado con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/search');

    expect(await screen.findByRole('heading', { level: 1, name: 'Buscar' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('renderiza Home dentro del layout privado con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('renderiza /profile dentro del layout privado con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/profile');

    expect(await screen.findByRole('heading', { name: 'Tu perfil' })).toBeInTheDocument();
    // Vive dentro del AppLayout existente: comparte header y navegación.
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('renderiza /rooms dentro del layout privado con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/rooms');

    expect(await screen.findByRole('heading', { name: 'Salas' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('renderiza el detalle de partido con sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderAt('/matches/match-001');

    // Ya no es un placeholder: la ruta monta la pantalla real, que resuelve su
    // título con el partido que devuelve la API.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
  });

  describe('ruta a la que vuelve el login', () => {
    let emit: (event: AuthChangeEvent, next: Session | null) => void = () => {};

    beforeEach(() => {
      authMock.onAuthStateChange.mockImplementation((callback) => {
        emit = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      });
      authMock.getSession.mockResolvedValue({ data: { session }, error: null });
      // Como el cliente real: avisa `SIGNED_OUT` antes de resolver.
      authMock.signOut.mockImplementation(async () => {
        emit('SIGNED_OUT', null);
        return { error: null };
      });
      authMock.signInWithPassword.mockImplementation(async () => {
        emit('SIGNED_IN', session);
        return { data: { user: session.user, session }, error: null };
      });
    });

    async function logIn(user: ReturnType<typeof userEvent.setup>) {
      expect(
        await screen.findByRole('heading', { name: 'Entrá a la tribuna' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('Correo electrónico'), 'otra@watchparty.test');
      await user.type(screen.getByLabelText('Contraseña'), 'contrasena-segura');
      await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    }

    it('después de cerrar sesión desde el header, el próximo login va a Inicio', async () => {
      const user = userEvent.setup();
      renderAt('/search?q=boca#resultados');
      expect(await screen.findByRole('heading', { level: 1, name: 'Buscar' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
      await logIn(user);

      expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: 'Buscar' })).not.toBeInTheDocument();
    });

    it('si falla el pedido de logout, el próximo login también va a Inicio', async () => {
      // Como el cliente real: espera la respuesta del `POST /logout` y, aunque
      // falle, borra la sesión local y avisa `SIGNED_OUT` antes de devolver el
      // error.
      authMock.signOut.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        emit('SIGNED_OUT', null);
        return { error: { name: 'AuthApiError', message: 'Internal error', status: 500 } };
      });
      const user = userEvent.setup();
      renderAt('/search');
      expect(await screen.findByRole('heading', { level: 1, name: 'Buscar' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
      await logIn(user);

      expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: 'Buscar' })).not.toBeInTheDocument();
    });

    it('si la sesión se pierde sin cerrarla, el login vuelve a la ruta en la que estaba', async () => {
      const user = userEvent.setup();
      renderAt('/search');
      expect(await screen.findByRole('heading', { level: 1, name: 'Buscar' })).toBeInTheDocument();

      act(() => {
        emit('SIGNED_OUT', null);
      });
      await logIn(user);

      expect(await screen.findByRole('heading', { level: 1, name: 'Buscar' })).toBeInTheDocument();
    });
  });
});
