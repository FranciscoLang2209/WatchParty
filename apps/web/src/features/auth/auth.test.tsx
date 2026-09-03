import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthError, Session } from '@supabase/supabase-js';
import type { AuthMode } from './auth-mode';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
  },
}));

vi.mock('../../lib/supabase', () => ({ supabase: { auth: authMock } }));

const { AuthPage } = await import('./AuthPage');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

const SUBMIT_LABEL: Record<AuthMode, string> = {
  login: 'Ingresar',
  register: 'Crear cuenta',
};

function authError(code: string, message: string): AuthError {
  return { name: 'AuthApiError', message, code, status: 400 } as AuthError;
}

function renderAuth(path: '/login' | '/register') {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/" element={<h1>Inicio</h1>} />
      </Routes>
    </MemoryRouter>,
  );

  return { user };
}

function fields() {
  return {
    email: screen.getByLabelText('Correo electrónico'),
    password: screen.getByLabelText('Contraseña'),
  };
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, mode: AuthMode) {
  if (mode === 'register') {
    await user.type(screen.getByLabelText('Usuario'), 'martu');
  }

  await user.type(fields().email, 'persona@watchparty.test');
  await user.type(fields().password, 'contrasena-segura');

  if (mode === 'register') {
    await user.type(screen.getByLabelText('Confirmar contraseña'), 'contrasena-segura');
  }

  await user.click(screen.getByRole('button', { name: SUBMIT_LABEL[mode] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.signUp.mockResolvedValue({ data: { user: session.user, session }, error: null });
  authMock.signInWithPassword.mockResolvedValue({
    data: { user: session.user, session },
    error: null,
  });
});

describe('Presentación de las pantallas de acceso', () => {
  it('usa el antetítulo y el título del mockup en login', () => {
    renderAuth('/login');

    expect(screen.getByText('Bienvenido de nuevo')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('usa el antetítulo, el título y la bajada del mockup en registro', () => {
    renderAuth('/register');

    expect(screen.getByText('Creá tu cuenta')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();
    expect(
      screen.getByText('Armá tu perfil para comentar, calificar y guardar cada partido.'),
    ).toBeInTheDocument();
  });

  it('el antetítulo se escribe en minúsculas y se muestra en mayúsculas por CSS', () => {
    renderAuth('/register');

    // Evita que un lector de pantalla deletree el texto letra por letra.
    expect(screen.getByText('Creá tu cuenta').className).toMatch(/\buppercase\b/);
  });

  it('permite cambiar de tema desde las pantallas de acceso', () => {
    renderAuth('/login');

    expect(
      screen.getByRole('button', { name: /activar modo (claro|oscuro)/i }),
    ).toBeInTheDocument();
  });

  it('no envuelve el formulario en una card', () => {
    renderAuth('/login');

    const form = screen.getByRole('button', { name: 'Ingresar' }).closest('form');

    expect(form?.closest('.bg-card')).toBeNull();
  });
});

describe('AuthPage en modo login', () => {
  it('renderiza el formulario de login con email y contraseña únicamente', () => {
    renderAuth('/login');

    expect(screen.getByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
    expect(fields().email).toBeInTheDocument();
    expect(fields().password).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Confirmar contraseña')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /google|github|oauth/i })).not.toBeInTheDocument();
  });

  it('configura los atributos de los campos de login', () => {
    renderAuth('/login');

    const { email, password } = fields();

    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(email).toHaveAttribute('placeholder', 'nombre@ejemplo.com');
    expect(email).toBeRequired();
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(password).toBeRequired();
    // El mínimo de 8 caracteres es una regla del registro, no del login.
    expect(password).not.toHaveAttribute('minlength');
  });

  it('llama a signInWithPassword y navega a / cuando el login es exitoso', async () => {
    const { user } = renderAuth('/login');

    await fillAndSubmit(user, 'login');

    expect(authMock.signInWithPassword).toHaveBeenCalledWith({
      email: 'persona@watchparty.test',
      password: 'contrasena-segura',
    });
    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });

  it('mantiene la página y muestra el error accesible con credenciales rechazadas', async () => {
    authMock.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: authError('invalid_credentials', 'Invalid login credentials'),
    });

    const { user } = renderAuth('/login');
    await fillAndSubmit(user, 'login');

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('El email o la contraseña no son correctos.');
    expect(alert).not.toHaveTextContent('contrasena-segura');
    expect(screen.getByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
    expect(fields().email).toHaveValue('persona@watchparty.test');
    expect(fields().email).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ingresar' })).toBeEnabled();
  });

  it('muestra un error recuperable si el login no devuelve sesión', async () => {
    authMock.signInWithPassword.mockResolvedValue({
      data: { user: session.user, session: null },
      error: null,
    });

    const { user } = renderAuth('/login');
    await fillAndSubmit(user, 'login');

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos iniciar tu sesión.');
    expect(screen.queryByRole('heading', { name: 'Inicio' })).not.toBeInTheDocument();
  });
});

describe('AuthPage en modo registro', () => {
  it('renderiza los cuatro campos del mockup, en orden', () => {
    renderAuth('/register');

    expect(screen.getByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();

    const form = screen.getByRole('button', { name: 'Crear cuenta' }).closest('form');
    const labels = Array.from(form?.querySelectorAll('label') ?? []).map((l) => l.textContent);

    expect(labels).toEqual(['Usuario', 'Correo electrónico', 'Contraseña', 'Confirmar contraseña']);
  });

  it('usa los placeholders del mockup', () => {
    renderAuth('/register');

    expect(screen.getByLabelText('Usuario')).toHaveAttribute('placeholder', 'Nombre de usuario');
    expect(fields().email).toHaveAttribute('placeholder', 'nombre@ejemplo.com');
    expect(fields().password).toHaveAttribute('placeholder', 'Mínimo 8 caracteres');
    expect(screen.getByLabelText('Confirmar contraseña')).toHaveAttribute(
      'placeholder',
      'Repetí tu contraseña',
    );
  });

  it('configura los atributos de los campos nuevos', () => {
    renderAuth('/register');

    const username = screen.getByLabelText('Usuario');
    const confirm = screen.getByLabelText('Confirmar contraseña');

    expect(username).toHaveAttribute('type', 'text');
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(username).toBeRequired();

    expect(confirm).toHaveAttribute('type', 'password');
    expect(confirm).toHaveAttribute('autocomplete', 'new-password');
    expect(confirm).toBeRequired();

    // El placeholder «Mínimo 8 caracteres» tiene que ser cierto.
    expect(fields().password).toHaveAttribute('minlength', '8');
    expect(fields().password).toHaveAttribute('autocomplete', 'new-password');
    expect(fields().email).toHaveAttribute('autocomplete', 'email');
  });

  it('llama a signUp con el nombre de usuario como metadata y navega a /', async () => {
    const { user } = renderAuth('/register');

    await fillAndSubmit(user, 'register');

    expect(authMock.signUp).toHaveBeenCalledWith({
      email: 'persona@watchparty.test',
      password: 'contrasena-segura',
      options: { data: { username: 'martu' } },
    });
    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });

  it('no llama a Supabase si las contraseñas no coinciden', async () => {
    const { user } = renderAuth('/register');

    await user.type(screen.getByLabelText('Usuario'), 'martu');
    await user.type(fields().email, 'persona@watchparty.test');
    await user.type(fields().password, 'contrasena-segura');
    await user.type(screen.getByLabelText('Confirmar contraseña'), 'otra-contrasena');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('Las contraseñas no coinciden.');
    expect(alert).not.toHaveTextContent('contrasena-segura');
    expect(authMock.signUp).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();
  });

  it('limpia el error de confirmación cuando las contraseñas pasan a coincidir', async () => {
    const { user } = renderAuth('/register');

    await user.type(screen.getByLabelText('Usuario'), 'martu');
    await user.type(fields().email, 'persona@watchparty.test');
    await user.type(fields().password, 'contrasena-segura');
    const confirm = screen.getByLabelText('Confirmar contraseña');
    await user.type(confirm, 'otra-contrasena');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    await screen.findByRole('alert');

    await user.clear(confirm);
    await user.type(confirm, 'contrasena-segura');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(authMock.signUp).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });

  it('no navega y muestra un error si el registro es exitoso pero no devuelve sesión', async () => {
    authMock.signUp.mockResolvedValue({
      data: { user: session.user, session: null },
      error: null,
    });

    const { user } = renderAuth('/register');
    await fillAndSubmit(user, 'register');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Creamos tu cuenta pero no pudimos iniciar la sesión automáticamente.',
    );
    expect(screen.queryByRole('heading', { name: 'Inicio' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();
  });

  it('no expone detalles internos de un error de Supabase', async () => {
    authMock.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: authError('user_already_exists', 'User already registered at /auth/v1/signup'),
    });

    const { user } = renderAuth('/register');
    await fillAndSubmit(user, 'register');

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('Ya existe una cuenta con ese email.');
    expect(alert).not.toHaveTextContent('/auth/v1/signup');
  });
});

describe('Estado pendiente y navegación entre páginas de acceso', () => {
  it('deshabilita campos y botón, y comunica el estado pendiente', async () => {
    authMock.signInWithPassword.mockReturnValue(new Promise(() => {}));

    const { user } = renderAuth('/login');
    await fillAndSubmit(user, 'login');

    const form = screen.getByRole('button', { name: 'Ingresando…' }).closest('form');

    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Ingresando…' })).toBeDisabled();
    expect(fields().email).toBeDisabled();
    expect(fields().password).toBeDisabled();
  });

  it('comunica el estado pendiente del registro y deshabilita los campos nuevos', async () => {
    authMock.signUp.mockReturnValue(new Promise(() => {}));

    const { user } = renderAuth('/register');
    await fillAndSubmit(user, 'register');

    expect(await screen.findByRole('button', { name: 'Creando cuenta…' })).toBeDisabled();
    expect(screen.getByLabelText('Usuario')).toBeDisabled();
    expect(screen.getByLabelText('Confirmar contraseña')).toBeDisabled();
  });

  it('impide el envío duplicado mientras la operación está pendiente', async () => {
    authMock.signInWithPassword.mockReturnValue(new Promise(() => {}));

    const { user } = renderAuth('/login');
    await fillAndSubmit(user, 'login');

    const pendingButton = screen.getByRole('button', { name: 'Ingresando…' });
    await user.click(pendingButton);
    await user.click(pendingButton);

    expect(authMock.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it('navega de login a registro y de vuelta conservando el SPA', async () => {
    const { user } = renderAuth('/login');

    await user.click(screen.getByRole('link', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('heading', { name: 'Sumate a la tribuna' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Ingresar' }));
    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('usa el texto del mockup para cambiar de pantalla', () => {
    renderAuth('/register');

    expect(screen.getByText(/¿Ya tenés una cuenta\?/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ingresar' })).toHaveAttribute('href', '/login');
  });

  it('muestra el logo con el nombre de WatchParty como imagen accesible', () => {
    renderAuth('/login');

    // JSDOM no aplica CSS, así que ambas variantes están en el DOM; en el
    // navegador la clase `dark` del <html> deja visible sólo una.
    const logos = screen.getAllByRole('img', { name: 'WatchParty' });
    expect(logos).toHaveLength(2);
    const claro = logos[0]!;
    const oscuro = logos[1]!;

    expect(claro).toHaveAttribute('src', '/title_logo.png');
    expect(oscuro).toHaveAttribute('src', '/title_logo-dark.png');

    // El logo ya contiene el nombre, así que se anuncia en vez de ocultarse.
    expect(claro).not.toHaveAttribute('aria-hidden');
    // Dimensiones intrínsecas reales del archivo: reservan el espacio correcto.
    expect(claro).toHaveAttribute('width', '1600');
    expect(claro).toHaveAttribute('height', '1095');
    // Ancho por token responsive, nunca fijo en píxeles.
    expect(claro.className).toMatch(/\bw-56\b/);
    expect(claro.className).not.toMatch(/\[\d+px\]/);
  });

  it('alterna las variantes del logo según el tema activo', () => {
    renderAuth('/login');

    const logos = screen.getAllByRole('img', { name: 'WatchParty' });
    const claro = logos[0]!;
    const oscuro = logos[1]!;

    // La variante clara desaparece en tema oscuro y viceversa.
    expect(claro.className).toMatch(/\bdark:hidden\b/);
    expect(oscuro.className).toMatch(/\bhidden\b/);
    expect(oscuro.className).toMatch(/\bdark:block\b/);
  });

  it('también muestra el logo en la página de registro', () => {
    renderAuth('/register');

    expect(
      screen.getAllByRole('img', { name: 'WatchParty' }).map((i) => i.getAttribute('src')),
    ).toEqual(['/title_logo.png', '/title_logo-dark.png']);
  });

  it('no incorpora ningún control de cierre de sesión', () => {
    renderAuth('/login');

    expect(screen.queryByRole('button', { name: /cerrar sesión/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /cerrar sesión/i })).not.toBeInTheDocument();
  });

  it('no aplica anchos fijos en píxeles al contenedor del formulario', () => {
    renderAuth('/login');

    const form = screen.getByRole('button', { name: 'Ingresar' }).closest('form');
    const container = form?.closest('div.max-w-md');

    expect(form).toHaveClass('w-full');
    expect(container).not.toBeNull();
    expect(container?.className).not.toMatch(/\[\d+px\]/);
  });
});

describe('Cuidado de la contraseña', () => {
  it('no persiste la contraseña fuera de Supabase Auth', async () => {
    const { user } = renderAuth('/login');

    await fillAndSubmit(user, 'login');

    expect(window.localStorage.getItem('password')).toBeNull();
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('contrasena-segura');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('contrasena-segura');
    expect(document.cookie).not.toContain('contrasena-segura');
  });
});
