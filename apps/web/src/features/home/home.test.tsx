import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const API_BASE = 'https://api.watchparty.test';

const { authMock, fromMock } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() },
  fromMock: vi.fn(),
}));

// Se mockea por el alias para comprobar de paso que `@/*` resuelve en los tests.
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

const river = {
  id: 'match-river-boca',
  homeTeam: 'River Plate',
  awayTeam: 'Boca Juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
};

const racing = {
  id: 'match-racing-inde',
  homeTeam: 'Racing Club',
  awayTeam: 'Independiente',
  kickoffAt: '2026-09-07T23:30:00Z',
  status: 'live',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

/**
 * Consultas acotadas a la región principal. El Header monta un `role="alert"`
 * permanente que CSS oculta cuando está vacío, y jsdom no evalúa CSS: sin
 * acotar, cualquier `getByRole('alert')` encontraría ese contenedor.
 */
async function home() {
  return within(await screen.findByRole('main'));
}

function conSesion() {
  authMock.getSession.mockResolvedValue({ data: { session }, error: null });
}

function ultimaPeticion() {
  const calls = fetchSpy.mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ matches: [] }));
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('Sesión y encabezado de la Home', () => {
  it('se monta en / con una sesión válida', async () => {
    conSesion();

    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });

  it('expone un único encabezado accesible «Inicio», oculto visualmente', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/');
    await screen.findAllByRole('link', { name: /Ver partido/ });

    // Las tarjetas aportan h2; el h1 de la página sigue siendo uno solo.
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

  it('la Home no aporta Header ni navegación propios', async () => {
    conSesion();

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    // El Header lo monta AppLayout, no la página: dentro de main no hay ninguno.
    const main = within(screen.getByRole('main'));

    expect(main.queryByRole('banner')).not.toBeInTheDocument();
    expect(main.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('no consulta tablas de Supabase', async () => {
    conSesion();

    renderAt('/');
    await screen.findByRole('heading', { name: 'Inicio' });

    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('Listado de partidos', () => {
  it('anuncia la carga inicial', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    renderAt('/');

    const estado = await (await home()).findByRole('status');
    expect(estado).toHaveTextContent('Cargando partidos…');
  });

  it('consulta únicamente la Node API, con bearer', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));

    renderAt('/');
    await screen.findByRole('link', { name: /Ver partido/ });

    const [url, init] = ultimaPeticion();

    expect(url).toBe(`${API_BASE}/matches`);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('muestra una tarjeta por partido, en una lista semántica', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/');

    const lista = await screen.findByRole('list');
    const items = within(lista).getAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(within(lista).getByText(/River Plate/)).toBeInTheDocument();
    expect(within(lista).getByText(/Racing Club/)).toBeInTheDocument();
    expect(within(lista).getByText('En vivo')).toBeInTheDocument();
  });

  it('el enlace de cada tarjeta preserva el id opaco', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));

    renderAt('/');

    expect(
      await screen.findByRole('link', { name: 'Ver partido: River Plate vs. Boca Juniors' }),
    ).toHaveAttribute('href', '/matches/match-river-boca');
  });

  it('explica la lista vacía en vez de dejar la pantalla en blanco', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [] }));

    renderAt('/');

    const m = await home();
    expect(await m.findByText(/Todavía no hay partidos disponibles/)).toBeInTheDocument();
    expect(m.queryByRole('list')).not.toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Errores y reintento', () => {
  it('una caída de red se anuncia como error, no como lista vacía', async () => {
    conSesion();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderAt('/');

    const m = await home();
    const alerta = await m.findByRole('alert');

    expect(alerta).toHaveTextContent('No pudimos conectarnos.');
    expect(m.queryByText(/Todavía no hay partidos/)).not.toBeInTheDocument();
    expect(m.queryByRole('list')).not.toBeInTheDocument();
  });

  it('un 500 se anuncia como error recuperable', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error.' } }, 500),
    );

    renderAt('/');

    const m = await home();
    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos cargar los partidos.');
    expect(m.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('el reintento vuelve a consultar la API y muestra el resultado', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderAt('/');
    const m = await home();
    await m.findByRole('alert');

    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));
    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    expect(await m.findByRole('link', { name: /Ver partido/ })).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('ante un 401 ofrece reingresar y usa el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401),
    );

    renderAt('/');

    const m = await home();
    const alerta = await m.findByRole('alert');
    expect(alerta).toHaveTextContent('La sesión venció. Iniciá sesión nuevamente.');
    // No se ofrece reintentar: reintentar con un token vencido no sirve.
    expect(m.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(m.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    // El guard existente redirige al quedar sin sesión; la Home no navega sola.
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('Cancelación', () => {
  it('cancela la petición al desmontar y no anuncia nada', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    const vista = renderAt('/');
    await (await home()).findByRole('status');

    const [, init] = ultimaPeticion();
    expect(init.signal?.aborted).toBe(false);

    vista.unmount();

    // El cleanup del efecto aborta: la respuesta que llegue después se descarta.
    await waitFor(() => {
      expect(init.signal?.aborted).toBe(true);
    });
  });
});
