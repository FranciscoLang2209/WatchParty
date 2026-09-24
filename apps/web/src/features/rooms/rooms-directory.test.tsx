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

async function directorio() {
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

describe('Directorio de salas — carga', () => {
  it('se monta en /rooms con una sesión válida', async () => {
    conSesion();

    renderAt('/rooms');

    expect(await screen.findByRole('heading', { name: 'Salas' })).toBeInTheDocument();
  });

  it('anuncia la carga inicial', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    renderAt('/rooms');

    const estado = await (await directorio()).findByRole('status');
    expect(estado).toHaveTextContent('Cargando el directorio…');
  });

  it('consulta únicamente la Node API, con bearer', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));

    renderAt('/rooms');
    await (await directorio()).findByText(/River Plate/);

    const [url, init] = ultimaPeticion();

    expect(url).toBe(`${API_BASE}/matches`);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('no consulta tablas de Supabase', async () => {
    conSesion();

    renderAt('/rooms');
    await screen.findByRole('heading', { name: 'Salas' });

    expect(fromMock).not.toHaveBeenCalled();
  });

  it('explica la lista vacía en vez de dejar la pantalla en blanco', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [] }));

    renderAt('/rooms');

    const m = await directorio();
    expect(await m.findByText(/Todavía no hay partidos ni salas disponibles/)).toBeInTheDocument();
    expect(m.queryByRole('list')).not.toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Directorio de salas — errores y reintento', () => {
  it('una caída de red se anuncia como error', async () => {
    conSesion();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderAt('/rooms');

    const m = await directorio();
    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
  });

  it('un 500 se anuncia como error recuperable, con reintento', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error.' } }, 500),
    );

    renderAt('/rooms');

    const m = await directorio();
    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos cargar los partidos.');
    expect(m.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('el reintento vuelve a consultar la API', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('alert');

    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));
    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    await waitFor(() => expect(m.queryByRole('alert')).not.toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('ante un 401 ofrece reingresar y usa el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401),
    );

    renderAt('/rooms');

    const m = await directorio();
    const alerta = await m.findByRole('alert');
    expect(alerta).toHaveTextContent('La sesión venció. Iniciá sesión nuevamente.');
    expect(m.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(m.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('Directorio de salas — cancelación', () => {
  it('cancela la petición al desmontar y no anuncia nada', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    const vista = renderAt('/rooms');
    await (await directorio()).findByRole('status');

    const [, init] = ultimaPeticion();
    expect(init.signal?.aborted).toBe(false);

    vista.unmount();

    await waitFor(() => {
      expect(init.signal?.aborted).toBe(true);
    });
  });
});

describe('Directorio de salas — tarjetas', () => {
  it('muestra una tarjeta por partido, en una cuadrícula semántica', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');

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

    renderAt('/rooms');

    expect(
      await screen.findByRole('link', { name: 'Ver partido: River Plate vs. Boca Juniors' }),
    ).toHaveAttribute('href', '/matches/match-river-boca');
  });

  it('una lista vacía no muestra tarjetas fantasma', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [] }));

    renderAt('/rooms');

    await screen.findByRole('heading', { name: 'Salas' });
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ver partido/ })).not.toBeInTheDocument();
  });

  it('el foco recorre las tarjetas en orden, sin perderse en la cuadrícula', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');

    const primerEnlace = await screen.findByRole('link', {
      name: 'Ver partido: River Plate vs. Boca Juniors',
    });
    const segundoEnlace = screen.getByRole('link', {
      name: 'Ver partido: Racing Club vs. Independiente',
    });

    primerEnlace.focus();
    expect(primerEnlace).toHaveFocus();

    await user.tab();
    expect(segundoEnlace).toHaveFocus();
  });
});
