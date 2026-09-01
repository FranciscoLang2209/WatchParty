import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BottomNavigation } from './BottomNavigation';
import { NAVIGATION_ITEMS } from './navigation-items';

function renderNav(path = '/') {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNavigation />
      <Routes>
        <Route path="/" element={<p>ruta: /</p>} />
        <Route path="/rooms" element={<p>ruta: /rooms</p>} />
      </Routes>
    </MemoryRouter>,
  );

  return { user, nav: screen.getByRole('navigation', { name: 'Navegación móvil' }) };
}

describe('BottomNavigation', () => {
  it('renderiza los cuatro destinos', () => {
    const { nav } = renderNav();

    expect(within(nav).getByRole('link', { name: 'Inicio' })).toBeInTheDocument();
    for (const label of ['Salas', 'Buscar', 'Perfil']) {
      expect(
        within(nav).getByRole('button', { name: `${label}, Próximamente` }),
      ).toBeInTheDocument();
    }
  });

  it('reutiliza la configuración compartida, sin declarar destinos propios', () => {
    const { nav } = renderNav();

    const rendered = Array.from(nav.children).map((child) => child.textContent?.trim());

    expect(rendered).toEqual(NAVIGATION_ITEMS.map((item) => item.label));
  });

  it('conserva el orden de lectura y de tabulación', async () => {
    const { user, nav } = renderNav();

    const order = Array.from(nav.querySelectorAll('a, button')).map((el) => el.textContent?.trim());
    expect(order).toEqual(['Inicio', 'Salas', 'Buscar', 'Perfil']);

    await user.tab();
    expect(within(nav).getByRole('link', { name: 'Inicio' })).toHaveFocus();

    await user.tab();
    expect(within(nav).getByRole('button', { name: 'Salas, Próximamente' })).toHaveFocus();
  });

  it('marca Inicio como activo con aria-current en /', () => {
    const { nav } = renderNav('/');

    expect(within(nav).getByRole('link', { name: 'Inicio' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('no marca Inicio como activo en otra ruta', () => {
    const { nav } = renderNav('/rooms');

    expect(within(nav).getByRole('link', { name: 'Inicio' })).not.toHaveAttribute('aria-current');
  });

  it('distingue el destino activo por más de una señal, sin fondo propio', () => {
    const { nav } = renderNav('/');

    const inicio = within(nav).getByRole('link', { name: 'Inicio' });
    const icono = inicio.querySelector('svg');
    const label = inicio.querySelector('span');

    expect(inicio.className).toMatch(/text-primary/);
    expect(label?.className).toMatch(/font-semibold/);
    expect(icono).toHaveAttribute('stroke-width', '2.5');
    expect(icono).toHaveAttribute('fill', 'currentColor');
    expect(inicio.className).not.toMatch(/bg-primary/);
  });

  it('Inicio navega a /', async () => {
    const { user, nav } = renderNav('/rooms');

    await user.click(within(nav).getByRole('link', { name: 'Inicio' }));

    expect(screen.getByText('ruta: /')).toBeInTheDocument();
  });

  it('los destinos no disponibles no modifican la URL', async () => {
    const { user, nav } = renderNav('/');

    await user.click(within(nav).getByRole('button', { name: 'Salas, Próximamente' }));

    expect(screen.getByText('ruta: /')).toBeInTheDocument();
    expect(screen.queryByText('ruta: /rooms')).not.toBeInTheDocument();
  });

  it('marca los destinos futuros como no disponibles', () => {
    const { nav } = renderNav();

    for (const label of ['Salas', 'Buscar', 'Perfil']) {
      expect(within(nav).getByRole('button', { name: `${label}, Próximamente` })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
  });

  it('cada destino cumple el área táctil mínima y muestra icono y label', () => {
    const { nav } = renderNav();

    for (const control of nav.querySelectorAll('a, button')) {
      expect(control.className).toMatch(/min-h-11/);
      expect(control.querySelector('svg')).not.toBeNull();
      expect(control.querySelector('span')?.textContent).toBeTruthy();
    }
  });

  it('se posiciona fija, respeta el área segura y se oculta desde 981 px', () => {
    const { nav } = renderNav();

    expect(nav.className).toMatch(/\bfixed\b/);
    expect(nav.className).toMatch(/\binset-x-3\b/);
    expect(nav.className).toMatch(/\bbottom-safe-bottom\b/);
    expect(nav.className).toMatch(/\bgrid-cols-4\b/);
    expect(nav.className).toMatch(/\bdesktop:hidden\b/);
  });
});

describe('BottomNavigation dentro del layout', () => {
  it('se muestra en rutas privadas y no en login ni registro', async () => {
    vi.resetModules();

    const authMock = {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signOut: vi.fn(),
    };
    vi.doMock('@/lib/supabase', () => ({ supabase: { auth: authMock, from: vi.fn() } }));

    const { AuthProvider } = await import('@/auth/AuthProvider');
    const { AppRoutes } = await import('@/app/router');
    const session = { access_token: 't', user: { id: 'u', email: 'a@b.com' } };

    function renderRoute(path: string) {
      return render(
        <AuthProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>,
      );
    }

    // Con sesión, la ruta privada monta el layout y con él la navegación.
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });
    const privada = renderRoute('/');
    expect(await screen.findByRole('navigation', { name: 'Navegación móvil' })).toBeInTheDocument();
    privada.unmount();

    // Login y registro son públicos: no montan el layout autenticado.
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const login = renderRoute('/login');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });
    expect(screen.queryByRole('navigation', { name: 'Navegación móvil' })).not.toBeInTheDocument();
    login.unmount();

    renderRoute('/register');
    await screen.findByRole('heading', { name: 'Crear cuenta' });
    expect(screen.queryByRole('navigation', { name: 'Navegación móvil' })).not.toBeInTheDocument();

    vi.doUnmock('@/lib/supabase');
  });
});
