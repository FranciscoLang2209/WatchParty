import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, AuthError, Session } from '@supabase/supabase-js';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
    updateUser: vi.fn(),
    signInWithPassword: vi.fn(),
  },
}));

vi.mock('../../lib/supabase', () => ({ supabase: { auth: authMock } }));
vi.mock('../../lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: 'https://api.watchparty.test',
  }),
}));

const { AuthProvider } = await import('../../auth/AuthProvider');
const { useAuth } = await import('../../auth/useAuth');
const { ResetPasswordPage } = await import('./ResetPasswordPage');
const { AppRoutes } = await import('../../app/router');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

let emitAuthChange: (event: AuthChangeEvent, session: Session | null) => void;

/** Deja ver desde afuera si el modo recuperación sigue habilitado. */
function RecoveryProbe() {
  const { isRecovering } = useAuth();

  return <span data-testid="recovery">{isRecovering ? 'habilitado' : 'apagado'}</span>;
}

function renderPage() {
  const user = userEvent.setup();

  render(
    <AuthProvider>
      <RecoveryProbe />
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<h1>Entrá a la tribuna</h1>} />
          <Route path="/forgot-password" element={<h1>¿Olvidaste tu contraseña?</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

  return { user };
}

/** Simula la llegada desde el enlace del correo, ya con la sesión restaurada. */
async function llegarDesdeElEnlace() {
  await screen.findByRole('link', { name: 'Pedir un enlace nuevo' });

  act(() => {
    emitAuthChange('PASSWORD_RECOVERY', session);
  });
}

async function completarFormulario(
  user: ReturnType<typeof userEvent.setup>,
  password: string,
  confirmacion = password,
) {
  await user.type(screen.getByLabelText('Contraseña nueva'), password);
  await user.type(screen.getByLabelText('Confirmar contraseña nueva'), confirmacion);
  await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.updateUser.mockResolvedValue({ data: { user: session.user }, error: null });
  authMock.signInWithPassword.mockImplementation(() => {
    // El cliente real anuncia la sesión nueva antes de resolver: sin eso, la
    // ruta privada rebotaría al login.
    emitAuthChange('SIGNED_IN', session);

    return Promise.resolve({ data: { session, user: session.user }, error: null });
  });
  authMock.onAuthStateChange.mockImplementation(
    (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
      emitAuthChange = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  );
});

describe('ResetPasswordPage sin autorización de recuperación', () => {
  it('no ofrece cambiar la contraseña a una sesión común', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderPage();

    // Estar logueada no alcanza: sin la señal del correo no se cambia nada.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El enlace no es válido o ya venció',
    );
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
  });

  it('no ofrece cambiar la contraseña sin sesión', async () => {
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El enlace no es válido o ya venció',
    );
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
  });

  it('deja pedir un enlace nuevo', async () => {
    const { user } = renderPage();

    await user.click(await screen.findByRole('link', { name: 'Pedir un enlace nuevo' }));

    expect(
      await screen.findByRole('heading', { name: '¿Olvidaste tu contraseña?' }),
    ).toBeInTheDocument();
  });

  it('espera a que se restaure la sesión antes de dar el enlace por inválido', () => {
    authMock.getSession.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Verificando el enlace…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ResetPasswordPage: los fallos son presentables', () => {
  it('anuncia el enlace inválido en una región viva', async () => {
    renderPage();

    const alerta = await screen.findByRole('alert');

    // Quien usa lector de pantalla se entera del fallo sin ir a buscarlo.
    expect(alerta).toHaveAttribute('aria-live', 'assertive');
  });

  it('no revela el token de la sesión de recuperación', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderPage();
    await screen.findByRole('alert');

    expect(document.body.textContent).not.toContain(session.access_token);
  });

  it('no revela de quién es la cuenta del enlace', async () => {
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });

    renderPage();
    await screen.findByRole('alert');

    expect(document.body.textContent).not.toContain('a@b.com');
  });
});

describe('ResetPasswordPage con el enlace de recuperación', () => {
  beforeEach(() => {
    // Supabase deja la sesión del enlace guardada antes de anunciar el evento.
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });
  });

  it('muestra el formulario de contraseña nueva', async () => {
    renderPage();

    await llegarDesdeElEnlace();

    expect(screen.getByRole('heading', { name: 'Creá una contraseña nueva' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña nueva')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(screen.getByLabelText('Confirmar contraseña nueva')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    // El contenedor de errores existe siempre; lo que importa es que llegue vacío.
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('rechaza contraseñas distintas sin molestar al proveedor', async () => {
    const { user } = renderPage();
    await llegarDesdeElEnlace();

    await completarFormulario(user, 'contraseña-1', 'contraseña-2');

    expect(await screen.findByRole('alert')).toHaveTextContent('Las contraseñas no coinciden.');
    expect(authMock.updateUser).not.toHaveBeenCalled();
  });

  it('exige el mínimo de caracteres', async () => {
    const { user } = renderPage();
    await llegarDesdeElEnlace();

    await completarFormulario(user, 'corta');

    expect(await screen.findByRole('alert')).toHaveTextContent('al menos 8 caracteres');
    expect(authMock.updateUser).not.toHaveBeenCalled();
  });

  it('comunica el estado pendiente y no permite un segundo envío', async () => {
    authMock.updateUser.mockReturnValue(new Promise(() => {}));

    const { user } = renderPage();
    await llegarDesdeElEnlace();

    await completarFormulario(user, 'contraseña-nueva');

    const pendiente = screen.getByRole('button', { name: 'Guardando…' });

    expect(pendiente.closest('form')).toHaveAttribute('aria-busy', 'true');
    expect(pendiente).toBeDisabled();

    await user.click(pendiente);

    expect(authMock.updateUser).toHaveBeenCalledTimes(1);
  });

  it('no expone el error interno del proveedor', async () => {
    authMock.updateUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: 'AuthApiError',
        message: 'Auth session missing at /auth/v1/user',
        code: 'session_not_found',
        status: 401,
      } as AuthError,
    });

    const { user } = renderPage();
    await llegarDesdeElEnlace();

    await completarFormulario(user, 'contraseña-nueva');

    const alerta = await screen.findByRole('alert');

    expect(alerta).toHaveTextContent('No pudimos guardar la contraseña.');
    expect(alerta).not.toHaveTextContent('/auth/v1/user');
    expect(alerta).not.toHaveTextContent('session_not_found');
    expect(alerta).not.toHaveTextContent('contraseña-nueva');
    expect(alerta).toHaveAttribute('aria-live', 'assertive');
    expect(document.body.textContent).not.toContain(session.access_token);
    // Se puede reintentar: el formulario sigue en pie.
    expect(screen.getByRole('button', { name: 'Guardar contraseña' })).toBeEnabled();
  });

  it('guarda la contraseña nueva y devuelve al login', async () => {
    const { user } = renderPage();
    await llegarDesdeElEnlace();

    await completarFormulario(user, 'contraseña-nueva');

    expect(authMock.updateUser).toHaveBeenCalledWith({ password: 'contraseña-nueva' });
    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });

  it('no deja una sesión de recuperación reutilizable después del cambio', async () => {
    const { user } = renderPage();
    await llegarDesdeElEnlace();

    expect(screen.getByTestId('recovery')).toHaveTextContent('habilitado');

    await completarFormulario(user, 'contraseña-nueva');
    await screen.findByRole('heading', { name: 'Entrá a la tribuna' });

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('recovery')).toHaveTextContent('apagado'));
  });
});

describe('el flujo completo de recuperación', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // La Home privada consulta la Node API: se responde desde el test para no
    // dejar peticiones reales sueltas.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ matches: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('deja iniciar sesión de nuevo con la contraseña recién creada', async () => {
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/reset-password']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    );

    await llegarDesdeElEnlace();
    await completarFormulario(user, 'contraseña-nueva');

    // El cambio termina en el login, sin sesión de recuperación viva.
    await screen.findByRole('heading', { name: 'Entrá a la tribuna' });

    await user.type(screen.getByLabelText('Correo electrónico'), 'persona@watchparty.test');
    await user.type(screen.getByLabelText('Contraseña'), 'contraseña-nueva');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(authMock.signInWithPassword).toHaveBeenCalledWith({
      email: 'persona@watchparty.test',
      password: 'contraseña-nueva',
    });
    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });
});
