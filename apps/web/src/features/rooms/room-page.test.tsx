import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const API_BASE = 'https://api.watchparty.test';

const { authMock, fromMock } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() },
  fromMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: authMock, from: fromMock } }));
vi.mock('@/lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  }),
}));

const { AuthProvider } = await import('@/auth/AuthProvider');
const { AppRoutes } = await import('@/app/router');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

const sala = {
  id: 'room-123',
  matchId: 'match-001',
  createdAt: '2026-09-18T21:00:00.000Z',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const COMENTARIOS_URL = `${API_BASE}/rooms/room-123/comments`;

/**
 * La lista de comentarios pide su propia URL: se responde vacía para que las
 * pruebas de la sala no dependan de ella.
 */
function responderCon(body: unknown, status = 200) {
  fetchSpy.mockImplementation((input: unknown) =>
    Promise.resolve(
      String(input).endsWith('/comments')
        ? jsonResponse({ comments: [] })
        : jsonResponse(body, status),
    ),
  );
}

function llamadasA(url: string): [string, RequestInit][] {
  return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
    ([destino]) => String(destino) === url,
  );
}

/** Simula navegar dentro de la SPA a otra sala sin pasar por otra pantalla. */
function IrAOtraSala() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/rooms/desconocida')}>
      Ir a otra sala
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <IrAOtraSala />
      </MemoryRouter>
    </AuthProvider>,
  );
}

/**
 * Consultas acotadas a la región principal: el Header monta un `role="alert"`
 * permanente que CSS oculta cuando está vacío, y jsdom no evalúa CSS.
 */
async function pantalla() {
  return within(await screen.findByRole('main'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  responderCon({ room: sala });
  authMock.getSession.mockResolvedValue({ data: { session }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('Sala: éxito', () => {
  it('abre por URL directa, consulta la API con bearer y muestra esa sala', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(
      await p.findByRole('heading', { level: 1, name: 'Sala del partido' }),
    ).toBeInTheDocument();
    expect(p.getByText('room-123')).toBeInTheDocument();
    const llamadas = llamadasA(`${API_BASE}/rooms/room-123`);
    const [, init] = llamadas[0] as [string, RequestInit];

    expect(llamadas).toHaveLength(1);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('anuncia la carga', async () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));

    renderAt('/rooms/room-123');

    expect(await (await pantalla()).findByRole('status')).toHaveTextContent('Cargando la sala…');
  });

  it('en móvil el identificador corta línea en vez de desbordar', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();
    const identificador = await p.findByText('room-123');

    expect(identificador.className).toMatch(/min-w-0/);
    expect(identificador.className).toMatch(/break-all/);
  });

  it('muestra el formulario y la lista de comentarios de la sala', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByLabelText('Comentario')).toBeInTheDocument();
    expect(
      await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.'),
    ).toBeInTheDocument();

    const llamadas = llamadasA(COMENTARIOS_URL);
    const [, init] = llamadas[0] as [string, RequestInit];

    expect(llamadas).toHaveLength(1);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('un comentario publicado aparece en la lista sin recargar', async () => {
    const user = userEvent.setup();
    const creado = {
      id: 'comentario-1',
      roomId: 'room-123',
      body: '¡Qué golazo!',
      createdAt: '2026-09-24T21:00:00.000Z',
    };

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.');

    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ comment: creado }, 201)));

    await user.type(p.getByLabelText('Comentario'), creado.body);
    await user.click(p.getByRole('button', { name: 'Comentar' }));

    expect(await p.findByText(creado.body)).toBeInTheDocument();
  });

  it('si la lista responde 401 ofrece reingresar con el flujo de Auth', async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).endsWith('/comments')
          ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)
          : jsonResponse({ room: sala }),
      ),
    );

    renderAt('/rooms/room-123');

    const p = await pantalla();

    await user.click(await p.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('redirige a /login sin sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });

    renderAt('/rooms/room-123');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });
});

describe('Sala: estados alternativos', () => {
  it('un 404 se comunica como sala inexistente, no como error recuperable', async () => {
    responderCon({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' } }, 404);

    renderAt('/rooms/desconocida');

    const p = await pantalla();

    expect(await p.findByText('No encontramos esa sala.')).toBeInTheDocument();
    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('un 500 se anuncia como error recuperable y el reintento vuelve a consultar', async () => {
    const user = userEvent.setup();
    responderCon({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent(
      'No pudimos abrir la sala. Intentá de nuevo.',
    );

    responderCon({ room: sala });
    await user.click(p.getByRole('button', { name: 'Reintentar' }));

    expect(await p.findByText('room-123')).toBeInTheDocument();
    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(llamadasA(`${API_BASE}/rooms/room-123`)).toHaveLength(2);
  });

  it('una caída de red se anuncia como error recuperable', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
    expect(p.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('ante un 401 ofrece reingresar con el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    responderCon({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent(
      'La sesión venció. Iniciá sesión nuevamente.',
    );
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('al pasar a un id desconocido no deja visible la sala anterior', async () => {
    const user = userEvent.setup();

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText('room-123');

    let responder404: () => void = () => {};
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          responder404 = () =>
            resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: 'x' } }, 404));
        }),
    );

    await user.click(screen.getByRole('button', { name: 'Ir a otra sala' }));

    expect(await p.findByRole('status')).toHaveTextContent('Cargando la sala…');
    expect(p.queryByText('room-123')).not.toBeInTheDocument();

    responder404();

    expect(await p.findByText('No encontramos esa sala.')).toBeInTheDocument();
    expect(p.queryByText('room-123')).not.toBeInTheDocument();
  });

  it('no monta comentarios si la sala no existe', async () => {
    responderCon({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' } }, 404);

    renderAt('/rooms/desconocida');

    const p = await pantalla();
    await p.findByText('No encontramos esa sala.');

    expect(p.queryByRole('textbox')).not.toBeInTheDocument();
    expect(llamadasA(`${API_BASE}/rooms/desconocida/comments`)).toHaveLength(0);
  });
});
