import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A diferencia de `reset-password.test.tsx`, acá NO se simula Supabase Auth: se usa el cliente
 * real (`lib/supabase`) y lo único que se falsea es la red. Así se comprueba que el enlace del
 * correo, tal como llega a la URL, termina emitiendo `PASSWORD_RECOVERY` y habilitando el cambio.
 */
vi.mock('@/lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: 'https://api.watchparty.test',
  }),
}));

const USUARIO = {
  id: 'user-1',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'a@b.com',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};

const INVALIDO = 'El enlace no es válido o ya venció';

function tokens(type: string) {
  return `#access_token=access-1&refresh_token=refresh-1&expires_in=3600&token_type=bearer&type=${type}`;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let responderUsuario: () => void;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();

  // Para un enlace con sesión, el cliente consulta al proveedor quién es el usuario antes de
  // emitir nada. Esa respuesta se retiene hasta después de montar la app: es lo que pasa en
  // producción (la red tarda más que el primer render) y evita depender de cuánto tardan los
  // `import()` de la prueba.
  const usuarioListo = new Promise<void>((resolver) => (responderUsuario = resolver));

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
    if (!String(input).endsWith('/auth/v1/user')) return new Response('{}', { status: 404 });

    await usuarioListo;

    return new Response(JSON.stringify(USUARIO), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  window.history.replaceState(null, '', '/');
});

/**
 * Abre `/reset-password` con el hash que dejaría el enlace del correo. El cliente de Supabase
 * lee la URL al crearse, así que los módulos se importan después de fijarla.
 */
async function abrirEnlace(hash: string) {
  vi.resetModules();
  window.history.replaceState(null, '', `/reset-password${hash}`);

  const { AuthProvider } = await import('./AuthProvider');
  const { ResetPasswordPage } = await import('../features/auth/ResetPasswordPage');

  // La pantalla no puede afirmar «enlace inválido» antes de tiempo: se registra si alguna vez
  // llegó a mostrarse, aunque sea por un instante.
  let seMostroInvalido = false;
  const observador = new MutationObserver(() => {
    if (document.body.textContent?.includes(INVALIDO)) seMostroInvalido = true;
  });
  observador.observe(document.body, { childList: true, subtree: true, characterData: true });

  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/forgot-password" element={<h1>Recuperar contraseña</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

  // La app ya montó y se suscribió: recién ahora responde la red.
  await act(async () => {});
  responderUsuario();

  return { seMostroInvalido: () => seMostroInvalido, cerrar: () => observador.disconnect() };
}

describe('enlace de recuperación — procesamiento real del callback', () => {
  it('un enlace de recuperación válido habilita el formulario, sin pasar por «enlace inválido»', async () => {
    const vista = await abrirEnlace(tokens('recovery'));

    expect(await screen.findByLabelText('Contraseña nueva')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmar contraseña nueva')).toBeInTheDocument();
    expect(screen.queryByText(INVALIDO, { exact: false })).not.toBeInTheDocument();
    expect(vista.seMostroInvalido()).toBe(false);
    vista.cerrar();
  });

  it('los tokens no quedan en la URL después de procesar el enlace', async () => {
    const vista = await abrirEnlace(tokens('recovery'));

    await screen.findByLabelText('Contraseña nueva');

    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toMatch(/access_token|refresh_token/);
    vista.cerrar();
  });

  it('entrar a /reset-password sin enlace no ofrece el formulario', async () => {
    const vista = await abrirEnlace('');

    expect(await screen.findByText(INVALIDO, { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
    // Control del observador: cuando el aviso sí corresponde, queda registrado.
    expect(vista.seMostroInvalido()).toBe(true);
    vista.cerrar();
  });

  it('un enlace vencido muestra un mensaje recuperable con acceso a pedir otro', async () => {
    const vista = await abrirEnlace(
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );

    expect(await screen.findByText(INVALIDO, { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pedir un enlace nuevo/ })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    vista.cerrar();
  });

  it('una sesión que no viene de recuperación no habilita el cambio de contraseña', async () => {
    const vista = await abrirEnlace(tokens('signup'));

    await waitFor(() => expect(screen.getByText(INVALIDO, { exact: false })).toBeInTheDocument());
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
    vista.cerrar();
  });
});
