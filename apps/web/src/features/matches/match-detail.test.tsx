import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
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
const { MatchDetailPage } = await import('./MatchDetailPage');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

const partido = {
  id: 'match-001',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
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

  it('no incluye chat, marcador ni estadísticas; la sala es un único acceso', async () => {
    renderAt('/matches/match-001');

    const m = await detalle();
    await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

    expect(m.queryByText(/chat|comentar|calificar|estadística|minuto/i)).not.toBeInTheDocument();
    expect(m.getAllByText(/sala/i)).toHaveLength(1);
    expect(m.getByRole('button', { name: 'Entrar a la sala' })).toBeInTheDocument();
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

describe('Entrar a la sala', () => {
  const sala = { id: 'room-123', matchId: 'match-001', createdAt: '2026-09-18T21:00:00.000Z' };
  const URL_SALA = `${API_BASE}/matches/match-001/room`;

  /** El detalle se carga siempre bien; la respuesta de la sala la decide cada prueba. */
  function responderSala(respuesta: () => Promise<Response>) {
    fetchSpy.mockImplementation((url: RequestInfo | URL) =>
      String(url) === URL_SALA ? respuesta() : Promise.resolve(jsonResponse({ match: partido })),
    );
  }

  /**
   * `/rooms/:roomId` la registra WAT-154: acá una ruta sonda muestra a dónde
   * navegó el detalle, sin depender de esa pantalla.
   */
  function SondaSala() {
    const { roomId } = useParams<{ roomId: string }>();
    return <h1>Sala {roomId}</h1>;
  }

  function renderDetalle() {
    return render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/matches/match-001']}>
          <Routes>
            <Route path="/matches/:matchId" element={<MatchDetailPage />} />
            <Route path="/rooms/:roomId" element={<SondaSala />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  async function botonSala() {
    return screen.findByRole('button', { name: 'Entrar a la sala' });
  }

  it('entra con bearer y navega a la sala usando el roomId devuelto', async () => {
    const user = userEvent.setup();
    responderSala(() => Promise.resolve(jsonResponse({ room: sala })));

    renderDetalle();
    await user.click(await botonSala());

    expect(await screen.findByRole('heading', { name: 'Sala room-123' })).toBeInTheDocument();
    expect(ultimaUrl()).toBe(URL_SALA);
    expect(ultimoInit().method).toBe('POST');
    expect(new Headers(ultimoInit().headers).get('Authorization')).toBe(
      `Bearer ${session.access_token}`,
    );
  });

  it('deshabilita el botón mientras espera la respuesta', async () => {
    const user = userEvent.setup();
    responderSala(() => new Promise(() => {}));

    renderDetalle();
    const boton = await botonSala();
    await user.click(boton);

    expect(boton).toBeDisabled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, 'NOT_FOUND', 'No encontramos esa sala.'],
    [500, 'INTERNAL_ERROR', 'No pudimos abrir la sala. Intentá de nuevo.'],
  ])('un %i no navega, avisa el error y deja el botón usable', async (status, code, mensaje) => {
    const user = userEvent.setup();
    responderSala(() => Promise.resolve(jsonResponse({ error: { code, message: 'x' } }, status)));

    renderDetalle();
    const boton = await botonSala();
    await user.click(boton);

    expect(await screen.findByRole('alert')).toHaveTextContent(mensaje);
    expect(boton).toBeEnabled();
    expect(screen.queryByRole('heading', { name: /^Sala / })).not.toBeInTheDocument();
  });

  it('ante un 401 ofrece reingresar con el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    responderSala(() =>
      Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)),
    );

    renderDetalle();
    await user.click(await botonSala());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La sesión venció. Iniciá sesión nuevamente.',
    );

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: /^Sala / })).not.toBeInTheDocument();
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

describe('Marcar como visto', () => {
  const URL_VISTO = `${API_BASE}/matches/match-001/watched`;

  /** El detalle se carga siempre bien; la respuesta de «visto» la decide cada prueba. */
  function responderVisto(respuesta: (metodo: string) => Promise<Response>) {
    fetchSpy.mockImplementation((url: RequestInfo | URL, init?: RequestInit) =>
      String(url) === URL_VISTO
        ? respuesta(init?.method ?? 'GET')
        : Promise.resolve(jsonResponse({ match: partido })),
    );
  }

  /** Confirma el estado que se pidió: PUT marca y DELETE deshace. */
  function servidorQueConfirma() {
    responderVisto((metodo) => Promise.resolve(jsonResponse({ watched: metodo === 'PUT' })));
  }

  function llamadasVisto(): [string, RequestInit][] {
    return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
      ([url]) => String(url) === URL_VISTO,
    );
  }

  async function abrirDetalle() {
    renderAt('/matches/match-001');
    return detalle();
  }

  it('muestra «Marcar como visto» al abrir, con un nombre inequívoco, sin consultar nada', async () => {
    const m = await abrirDetalle();

    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(m.getAllByRole('button', { name: /visto/i })).toHaveLength(1);
    expect(llamadasVisto()).toHaveLength(0);
  });

  it('marca con PUT y bearer, y el texto pasa a «Deshacer visto»', async () => {
    const user = userEvent.setup();
    servidorQueConfirma();

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));

    expect(await m.findByRole('button', { name: 'Deshacer visto' })).toBeEnabled();
    expect(llamadasVisto()).toHaveLength(1);

    const [url, init] = llamadasVisto()[0]!;
    expect(url).toBe(URL_VISTO);
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('deshace con DELETE y el texto vuelve a «Marcar como visto»', async () => {
    const user = userEvent.setup();
    servidorQueConfirma();

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));
    await user.click(await m.findByRole('button', { name: 'Deshacer visto' }));

    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(llamadasVisto().map(([, init]) => init.method)).toEqual(['PUT', 'DELETE']);
  });

  it('mientras espera deshabilita la acción y no dispara operaciones duplicadas', async () => {
    const user = userEvent.setup();
    responderVisto(() => new Promise<Response>(() => {}));

    const m = await abrirDetalle();
    const boton = await m.findByRole('button', { name: 'Marcar como visto' });
    await user.click(boton);
    await user.click(boton);

    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute('aria-busy', 'true');
    // El estado no cambia hasta que el servidor responda.
    expect(boton).toHaveTextContent('Marcar como visto');
    expect(llamadasVisto()).toHaveLength(1);
  });

  it('un error de API avisa, conserva el estado confirmado y deja reintentar', async () => {
    const user = userEvent.setup();
    let fallar = true;
    responderVisto((metodo) =>
      Promise.resolve(
        fallar
          ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
          : jsonResponse({ watched: metodo === 'PUT' }),
      ),
    );

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));

    expect(await m.findByRole('alert')).toHaveTextContent(
      'No pudimos actualizar el partido visto. Intentá de nuevo.',
    );
    // Sigue el último estado confirmado y la acción queda disponible.
    expect(m.getByRole('button', { name: 'Marcar como visto' })).toBeEnabled();

    fallar = false;
    await user.click(m.getByRole('button', { name: 'Marcar como visto' }));

    expect(await m.findByRole('button', { name: 'Deshacer visto' })).toBeEnabled();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('un error al deshacer conserva «Deshacer visto»', async () => {
    const user = userEvent.setup();
    responderVisto((metodo) =>
      Promise.resolve(
        metodo === 'PUT'
          ? jsonResponse({ watched: true })
          : jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
      ),
    );

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));
    await user.click(await m.findByRole('button', { name: 'Deshacer visto' }));

    expect(await m.findByRole('alert')).toBeInTheDocument();
    expect(m.getByRole('button', { name: 'Deshacer visto' })).toBeEnabled();
  });

  it('una caída de red avisa y no cambia el estado', async () => {
    const user = userEvent.setup();
    responderVisto(() => Promise.reject(new TypeError('Failed to fetch')));

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));

    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
    expect(m.getByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
  });

  it('muestra el estado que confirma el servidor, no el que se pidió', async () => {
    const user = userEvent.setup();
    responderVisto(() => Promise.resolve(jsonResponse({ watched: false })));

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));

    await waitFor(() => expect(llamadasVisto()).toHaveLength(1));
    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(m.queryByRole('button', { name: 'Deshacer visto' })).not.toBeInTheDocument();
  });

  it('ante un 401 ofrece reingresar con el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    responderVisto(() =>
      Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)),
    );

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));

    expect(await m.findByRole('alert')).toHaveTextContent(
      'La sesión venció. Iniciá sesión nuevamente.',
    );

    await user.click(m.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('se opera con el teclado: Enter marca y Espacio deshace', async () => {
    const user = userEvent.setup();
    servidorQueConfirma();

    const m = await abrirDetalle();
    const marcar = await m.findByRole('button', { name: 'Marcar como visto' });
    marcar.focus();
    await user.keyboard('{Enter}');

    const deshacer = await m.findByRole('button', { name: 'Deshacer visto' });
    deshacer.focus();
    await user.keyboard(' ');

    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(llamadasVisto().map(([, init]) => init.method)).toEqual(['PUT', 'DELETE']);
  });
});
