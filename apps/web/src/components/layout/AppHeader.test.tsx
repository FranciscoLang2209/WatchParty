import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader';
import { AuthContext, type AuthContextValue } from '@/auth/auth-context';
import { THEME_STORAGE_KEY } from '@/lib/theme';

const signOut = vi.fn();

function renderHeader({
  path = '/',
  auth = {},
  ...props
}: { path?: string; auth?: Partial<AuthContextValue> } & {
  hasUnreadNotifications?: boolean;
} = {}) {
  const user = userEvent.setup();
  const value = {
    status: 'authenticated',
    session: null,
    user: null,
    signOut,
    isSigningOut: false,
    ...auth,
  } as AuthContextValue;

  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <AppHeader {...props} />
        <Routes>
          <Route path="/" element={<p>ruta: /</p>} />
          <Route path="/rooms" element={<p>ruta: /rooms</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  return { user };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  document.documentElement.className = '';
  signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  document.documentElement.className = '';
});

describe('AppHeader — marca y navegación', () => {
  it('el logo es un enlace a / con nombre accesible propio', () => {
    renderHeader();

    const logo = screen.getByRole('link', { name: 'WatchParty, ir al inicio' });

    expect(logo).toHaveAttribute('href', '/');

    // Dos variantes decorativas: el nombre accesible lo aporta el enlace.
    const imgs = Array.from(logo.querySelectorAll('img'));

    expect(imgs.map((img) => img.getAttribute('src'))).toEqual(['/logo.png', '/logo-dark.png']);
    for (const img of imgs) expect(img).toHaveAttribute('aria-hidden', 'true');
    expect(imgs[0]?.className).toMatch(/\bdark:hidden\b/);
    expect(imgs[1]?.className).toMatch(/\bdark:block\b/);
  });

  it('muestra los cuatro destinos de la configuración compartida', () => {
    renderHeader();

    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });

    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inicio' })).toBeInTheDocument();
    for (const label of ['Salas', 'Buscar', 'Perfil']) {
      expect(screen.getByRole('button', { name: `${label}, Próximamente` })).toBeInTheDocument();
    }
  });

  it('marca Inicio como activo derivándolo de la URL', () => {
    renderHeader({ path: '/' });

    expect(screen.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  });

  it('no marca Inicio como activo en otra ruta', () => {
    renderHeader({ path: '/rooms' });

    expect(screen.getByRole('link', { name: 'Inicio' })).not.toHaveAttribute('aria-current');
  });

  it('los destinos futuros están deshabilitados y no cambian la URL', async () => {
    const { user } = renderHeader({ path: '/' });

    const salas = screen.getByRole('button', { name: 'Salas, Próximamente' });

    expect(salas).toHaveAttribute('aria-disabled', 'true');
    expect(salas.tagName).toBe('BUTTON');

    await user.click(salas);

    expect(screen.getByText('ruta: /')).toBeInTheDocument();
    expect(screen.queryByText('ruta: /rooms')).not.toBeInTheDocument();
  });

  it('permite recorrer la cabecera con el teclado', async () => {
    const { user } = renderHeader();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('link', { name: 'WatchParty, ir al inicio' })).toHaveFocus();
  });

  it('ofrece un enlace de salto al contenido principal', () => {
    renderHeader();

    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveAttribute(
      'href',
      '#main-content',
    );
  });
});

describe('AppHeader — selector de tema', () => {
  it('alterna entre claro y oscuro y refleja el tema en el nombre accesible', async () => {
    const { user } = renderHeader();

    const toggle = screen.getByRole('button', { name: 'Activar modo oscuro' });
    await user.click(toggle);

    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    const back = screen.getByRole('button', { name: 'Activar modo claro' });
    await user.click(back);

    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('persiste la preferencia bajo watchparty-theme', async () => {
    const { user } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Activar modo oscuro' }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('restaura la preferencia guardada al montar', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    renderHeader();

    expect(document.documentElement).toHaveClass('dark');
    expect(screen.getByRole('button', { name: 'Activar modo claro' })).toBeInTheDocument();
  });
});

describe('AppHeader — notificaciones', () => {
  it('se muestra como no disponible y sin indicador por defecto', () => {
    renderHeader();

    const bell = screen.getByRole('button', { name: 'Notificaciones, Próximamente' });

    expect(bell).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('notifications-indicator')).not.toBeInTheDocument();
  });

  it('muestra el indicador sólo si se recibe hasUnreadNotifications', () => {
    renderHeader({ hasUnreadNotifications: true });

    expect(screen.getByTestId('notifications-indicator')).toBeInTheDocument();
  });
});

describe('AppHeader — cerrar sesión', () => {
  it('delega en el flujo público de sesión, sin llamar a Supabase', async () => {
    const { user } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('se deshabilita y comunica el estado mientras el cierre está pendiente', () => {
    renderHeader({ auth: { isSigningOut: true } });

    const button = screen.getByRole('button', { name: 'Cerrar sesión' });

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Cerrando sesión…');
  });

  it('anuncia un error de cierre sin sacar a la persona de la página', async () => {
    signOut.mockResolvedValue({ error: 'No pudimos cerrar la sesión. Intentá de nuevo.' });

    const { user } = renderHeader();
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('No pudimos cerrar la sesión.'),
    );
  });

  it('no duplica el acceso a Perfil dentro de las acciones globales', () => {
    renderHeader();

    expect(screen.getAllByRole('button', { name: /Perfil/ })).toHaveLength(1);
  });
});
