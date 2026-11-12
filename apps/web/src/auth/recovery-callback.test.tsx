import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_LINK_WAIT_MS, hashHasRecoveryLink } from './recovery-link';

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
let timeoutSpy: ReturnType<typeof vi.spyOn> | null;
let responderUsuario: () => void;
let usuarioValido: boolean;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  usuarioValido = true;
  timeoutSpy = null;

  // Para un enlace con sesión, el cliente consulta al proveedor quién es el usuario antes de
  // emitir nada. Esa respuesta se retiene hasta después de montar la app: es lo que pasa en
  // producción (la red tarda más que el primer render) y evita depender de cuánto tardan los
  // `import()` de la prueba.
  const usuarioListo = new Promise<void>((resolver) => (responderUsuario = resolver));

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
    if (!String(input).endsWith('/auth/v1/user')) return new Response('{}', { status: 404 });

    await usuarioListo;

    if (!usuarioValido) {
      return new Response(JSON.stringify({ code: 401, msg: 'invalid JWT' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(USUARIO), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  timeoutSpy?.mockRestore();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

/**
 * El cliente guarda la sesión del enlace, resuelve y recién DESPUÉS emite `PASSWORD_RECOVERY`
 * dentro de un `setTimeout(…, 0)`. Ese hueco dura unos milisegundos, así que una prueba que
 * dependa de él pasaría o fallaría según la velocidad de la máquina. Para no depender del
 * azar, se retrasan los `setTimeout` de 0 ms: el hueco pasa a durar `ms` y es siempre
 * observable. Con un valor enorme, la señal directamente no llega.
 */
function retrasarTimeoutsEnCero(ms: number) {
  const original = globalThis.setTimeout;

  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      original(
        handler as () => void,
        delay === undefined || delay === 0 ? ms : delay,
        ...args,
      )) as typeof setTimeout);
}

/**
 * Abre `/reset-password` con el hash que dejaría el enlace del correo. El cliente de Supabase
 * lee la URL al crearse, así que los módulos se importan después de fijarla.
 */
async function abrirEnlace(hash: string, opciones: { sinSenalDeRecuperacion?: boolean } = {}) {
  vi.resetModules();
  window.history.replaceState(null, '', `/reset-password${hash}`);

  if (opciones.sinSenalDeRecuperacion) {
    // El cliente procesa el enlace y resuelve la sesión, pero `PASSWORD_RECOVERY` no llega.
    const { supabase } = await import('../lib/supabase');
    const suscribir = supabase.auth.onAuthStateChange.bind(supabase.auth);

    vi.spyOn(supabase.auth, 'onAuthStateChange').mockImplementation((callback) =>
      suscribir((evento, sesion) => {
        if (evento !== 'PASSWORD_RECOVERY') void callback(evento, sesion);
      }),
    );
  }

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
    // Hueco entre «hay sesión» y `PASSWORD_RECOVERY` agrandado a 150 ms: ahí es donde antes se
    // anunciaba «enlace inválido» a quien abría un enlace bueno.
    retrasarTimeoutsEnCero(150);
    const vista = await abrirEnlace(tokens('recovery'));

    expect(await screen.findByLabelText('Contraseña nueva')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmar contraseña nueva')).toBeInTheDocument();
    expect(screen.queryByText(INVALIDO, { exact: false })).not.toBeInTheDocument();
    expect(vista.seMostroInvalido()).toBe(false);
    vista.cerrar();
  });

  it('mientras llega la señal de recuperación se muestra «Verificando…», no el aviso', async () => {
    retrasarTimeoutsEnCero(150);
    const vista = await abrirEnlace(tokens('recovery'));

    expect(screen.getByRole('status')).toHaveTextContent(/verificando/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await screen.findByLabelText('Contraseña nueva');
    expect(vista.seMostroInvalido()).toBe(false);
    vista.cerrar();
  });

  it('un enlace de recuperación cuyo token el proveedor rechaza avisa enseguida, sin esperar el tope', async () => {
    usuarioValido = false;
    const vista = await abrirEnlace(tokens('recovery'));

    // `findByText` espera 1 s como máximo: el tope de espera es de 2 s, así que si llega es
    // porque no se esperó.
    expect(await screen.findByText(INVALIDO, { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
    vista.cerrar();
  });

  it('si la señal de recuperación nunca llega, tras el tope se avisa en vez de quedar cargando', async () => {
    const vista = await abrirEnlace(tokens('recovery'), { sinSenalDeRecuperacion: true });

    expect(screen.getByRole('status')).toHaveTextContent(/verificando/i);

    expect(
      await screen.findByText(
        INVALIDO,
        { exact: false },
        { timeout: RECOVERY_LINK_WAIT_MS + 2000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
    vista.cerrar();
  }, 10_000);

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

describe('hashHasRecoveryLink', () => {
  it.each([
    [tokens('recovery'), true],
    [tokens('signup'), false],
    [tokens('magiclink'), false],
    ['#type=recovery', false],
    ['#error=access_denied&error_code=otp_expired', false],
    ['', false],
  ])('%s → %s', (hash, esperado) => {
    expect(hashHasRecoveryLink(hash)).toBe(esperado);
  });
});
