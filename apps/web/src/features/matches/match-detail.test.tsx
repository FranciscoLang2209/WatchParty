import { render, screen, within } from '@testing-library/react';
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

const partido = {
  id: 'match-001',
  homeTeam: 'River Plate',
  awayTeam: 'Boca Juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Cada llamada devuelve una `Response` nueva: el cuerpo se consume una sola vez. */
function responderCon(body: unknown, status = 200) {
  fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
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
 * Consultas acotadas a la región principal: el Header monta un `role="alert"`
 * permanente que CSS oculta cuando está vacío, y jsdom no evalúa CSS.
 */
async function detalle() {
  return within(await screen.findByRole('main'));
}

function ultimaUrl(): string {
  const calls = fetchSpy.mock.calls;
  return String((calls[calls.length - 1] as [string, RequestInit])[0]);
}

function ultimoInit(): RequestInit {
  const calls = fetchSpy.mock.calls;
  return (calls[calls.length - 1] as [string, RequestInit])[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  responderCon({ match: partido });
  authMock.getSession.mockResolvedValue({ data: { session }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('Detalle del partido: éxito', () => {
  it('abre por URL directa y muestra el contenido aprobado', async () => {
    renderAt('/matches/match-001');

    const m = await detalle();

    expect(
      await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
    expect(m.getByText('Programado')).toBeInTheDocument();
    expect(m.getByText(/18:00/)).toBeInTheDocument();
    expect(m.getByRole('link', { name: 'Volver a Home' })).toHaveAttribute('href', '/');
  });

  it('conserva un único h1 en la pantalla', async () => {
    renderAt('/matches/match-001');
    await screen.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('pasa el matchId sin alterarlo y con bearer', async () => {
    renderAt('/matches/id%20opaco%2Fraro');

    await screen.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

    // El router decodifica el parámetro; el cliente lo vuelve a codificar entero.
    expect(ultimaUrl()).toBe(`${API_BASE}/matches/id%20opaco%2Fraro`);
    expect(new Headers(ultimoInit().headers).get('Authorization')).toBe(
      `Bearer ${session.access_token}`,
    );
  });

  it('anuncia la carga', async () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));

    renderAt('/matches/match-001');

    expect(await (await detalle()).findByRole('status')).toHaveTextContent('Cargando el partido…');
  });

  it('no incluye sala, chat, marcador ni estadísticas', async () => {
    renderAt('/matches/match-001');

    const m = await detalle();
    await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

    expect(
      m.queryByText(/sala|chat|comentar|calificar|estadística|minuto/i),
    ).not.toBeInTheDocument();
    expect(m.queryByText(/\d+\s*-\s*\d+/)).not.toBeInTheDocument();
    expect(screen.getByRole('main').querySelectorAll('img')).toHaveLength(0);
  });

  it('redirige a /login sin sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });

    renderAt('/matches/match-001');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });
});

describe('Detalle del partido: estados alternativos', () => {
  it('un 404 se comunica como partido inexistente, no como error genérico', async () => {
    responderCon({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' } }, 404);

    renderAt('/matches/inexistente');

    const m = await detalle();

    expect(await m.findByText(/No encontramos ese partido/)).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    // Un partido que no existe no se reintenta: se vuelve.
    expect(m.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    expect(m.getByRole('link', { name: 'Volver a Home' })).toBeInTheDocument();
  });

  it('una caída de red se anuncia como error recuperable', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    renderAt('/matches/match-001');

    const m = await detalle();

    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
    expect(m.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('un 500 se anuncia como error recuperable', async () => {
    responderCon({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error.' } }, 500);

    renderAt('/matches/match-001');

    expect(await (await detalle()).findByRole('alert')).toHaveTextContent(
      'No pudimos cargar los partidos.',
    );
  });

  it('el reintento vuelve a consultar y muestra el partido', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));

    renderAt('/matches/match-001');

    const m = await detalle();
    await m.findByRole('alert');

    responderCon({ match: partido });
    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    expect(
      await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('ante un 401 ofrece reingresar con el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    responderCon({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401);

    renderAt('/matches/match-001');

    const m = await detalle();
    const alerta = await m.findByRole('alert');

    expect(alerta).toHaveTextContent('La sesión venció. Iniciá sesión nuevamente.');
    expect(m.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(m.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('Retorno a Home', () => {
  it('«Volver a Home» navega a / dentro de la SPA', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation((url: RequestInfo | URL) =>
      Promise.resolve(
        String(url).endsWith('/matches')
          ? jsonResponse({ matches: [] })
          : jsonResponse({ match: partido }),
      ),
    );

    renderAt('/matches/match-001');

    const m = await detalle();
    await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

    await user.click(m.getByRole('link', { name: 'Volver a Home' }));

    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
  });
});
