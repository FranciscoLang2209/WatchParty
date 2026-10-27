import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
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
  score: null,
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** La lectura de «visto» (WAT-179) corre aparte del detalle y la sala. */
function esVisto(url: RequestInfo | URL): boolean {
  return String(url).endsWith('/watched');
}

/** El resumen de calificaciones (WAT-215) también corre aparte del detalle. */
function esResumen(url: RequestInfo | URL): boolean {
  return String(url).endsWith('/rating-summary');
}

/**
 * Cada llamada devuelve una `Response` nueva: el cuerpo se consume una sola vez.
 * La lectura de «visto» confirma que no hay marca y el resumen que no hay votos,
 * salvo que la prueba lo redefina.
 */
function responderCon(body: unknown, status = 200) {
  fetchSpy.mockImplementation((url: RequestInfo | URL) =>
    Promise.resolve(
      esVisto(url)
        ? jsonResponse({ watched: false })
        : esResumen(url)
          ? jsonResponse({ average: null, count: 0 })
          : jsonResponse(body, status),
    ),
  );
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

/** Pedidos del detalle y la sala, sin las lecturas de «visto» ni del resumen. */
function llamadasSinVisto(): [string, RequestInit][] {
  return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
    ([url]) => !esVisto(url) && !esResumen(url),
  );
}

function ultimaUrl(): string {
  return String(llamadasSinVisto().at(-1)![0]);
}

function ultimoInit(): RequestInit {
  return llamadasSinVisto().at(-1)![1];
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

  it('no incluye chat ni estadísticas; la sala es un único acceso', async () => {
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

describe('Detalle del partido: marcador', () => {
  it('muestra el marcador real con cada gol asociado a su equipo, y el estado aparte', async () => {
    responderCon({ match: { ...partido, status: 'finished', score: { home: 2, away: 1 } } });
    renderAt('/matches/match-001');

    const m = await detalle();

    expect(await m.findByText('2 – 1')).toBeInTheDocument();
    expect(m.getByText('Resultado: River Plate 2, Boca Juniors 1')).toBeInTheDocument();
    expect(m.getByText('Finalizado')).toBeInTheDocument();
  });

  it('un 0–0 confirmado se muestra como resultado', async () => {
    responderCon({ match: { ...partido, status: 'finished', score: { home: 0, away: 0 } } });
    renderAt('/matches/match-001');

    const m = await detalle();

    expect(await m.findByText('0 – 0')).toBeInTheDocument();
    expect(m.queryByText('Sin resultado')).not.toBeInTheDocument();
  });

  it('sin marcador lo dice explícitamente, sin inventar un 0–0, y conserva equipos, fecha y estado', async () => {
    responderCon({ match: { ...partido, status: 'finished', score: null } });
    renderAt('/matches/match-001');

    const m = await detalle();

    expect(await m.findByText('Sin resultado')).toBeInTheDocument();
    expect(m.queryByText(/\d+\s*–\s*\d+/)).not.toBeInTheDocument();
    expect(
      m.getByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
    expect(m.getByText(/18:00/)).toBeInTheDocument();
    expect(m.getByText('Finalizado')).toBeInTheDocument();
  });

  it('un marcador con forma inválida se trata como error del servidor, no como resultado', async () => {
    responderCon({ match: { ...partido, score: { home: 1 } } });
    renderAt('/matches/match-001');

    const m = await detalle();

    expect(await m.findByRole('alert')).toBeInTheDocument();
    expect(m.queryByText(/\d+\s*–\s*\d+/)).not.toBeInTheDocument();
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
    expect(llamadasSinVisto()).toHaveLength(2);
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
    fetchSpy.mockImplementation((url: RequestInfo | URL) => {
      if (String(url) === URL_SALA) return respuesta();
      if (esVisto(url)) return Promise.resolve(jsonResponse({ watched: false }));

      return Promise.resolve(jsonResponse({ match: partido }));
    });
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
    expect(llamadasSinVisto()).toHaveLength(2);
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

  /**
   * El detalle se carga siempre bien. `respuesta` decide PUT/DELETE y
   * `lectura` el GET inicial, que por defecto confirma que no hay marca.
   */
  function responderVisto(
    respuesta: (metodo: string) => Promise<Response>,
    lectura: (init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(jsonResponse({ watched: false })),
  ) {
    fetchSpy.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== URL_VISTO) return Promise.resolve(jsonResponse({ match: partido }));

      const metodo = init?.method ?? 'GET';
      return metodo === 'GET' ? lectura(init) : respuesta(metodo);
    });
  }

  /** Persiste como el servidor real: PUT marca, DELETE deshace y GET lee lo guardado. */
  function servidorQueConfirma(inicial = false) {
    let persistido = inicial;

    responderVisto(
      (metodo) => {
        persistido = metodo === 'PUT';
        return Promise.resolve(jsonResponse({ watched: persistido }));
      },
      () => Promise.resolve(jsonResponse({ watched: persistido })),
    );
  }

  function pedidosVisto(): [string, RequestInit][] {
    return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
      ([url]) => String(url) === URL_VISTO,
    );
  }

  /** Solo las operaciones de marcar y deshacer, sin las lecturas. */
  function llamadasVisto(): [string, RequestInit][] {
    return pedidosVisto().filter(([, init]) => init.method !== 'GET');
  }

  function lecturasVisto(): [string, RequestInit][] {
    return pedidosVisto().filter(([, init]) => init.method === 'GET');
  }

  async function abrirDetalle() {
    renderAt('/matches/match-001');
    return detalle();
  }

  it('al abrir lee el estado con GET y bearer; sin marca muestra «Marcar como visto»', async () => {
    servidorQueConfirma();

    const m = await abrirDetalle();

    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(m.getAllByRole('button', { name: /visto/i })).toHaveLength(1);
    expect(llamadasVisto()).toHaveLength(0);
    expect(lecturasVisto()).toHaveLength(1);
    expect(new Headers(lecturasVisto()[0]![1].headers).get('Authorization')).toBe(
      `Bearer ${session.access_token}`,
    );
  });

  it('si el partido ya estaba marcado muestra «Deshacer visto» al abrir', async () => {
    servidorQueConfirma(true);

    const m = await abrirDetalle();

    expect(await m.findByRole('button', { name: 'Deshacer visto' })).toBeEnabled();
    expect(m.queryByRole('button', { name: 'Marcar como visto' })).not.toBeInTheDocument();
  });

  it('marcar, recargar y desmarcar reflejan el estado persistido', async () => {
    const user = userEvent.setup();
    servidorQueConfirma();

    const primeraCarga = renderAt('/matches/match-001');
    await user.click(await screen.findByRole('button', { name: 'Marcar como visto' }));
    await screen.findByRole('button', { name: 'Deshacer visto' });
    primeraCarga.unmount();

    const m = await abrirDetalle();
    await user.click(await m.findByRole('button', { name: 'Deshacer visto' }));

    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(llamadasVisto().map(([, init]) => init.method)).toEqual(['PUT', 'DELETE']);
  });

  it('mientras lee no ofrece ninguna acción ni lo presenta como no visto', async () => {
    responderVisto(
      () => Promise.resolve(jsonResponse({ watched: true })),
      () => new Promise<Response>(() => {}),
    );

    const m = await abrirDetalle();
    await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

    expect(await m.findByRole('status')).toHaveTextContent('Consultando si ya viste este partido…');
    expect(m.queryByRole('button', { name: /visto/i })).not.toBeInTheDocument();
  });

  it('un error al leer avisa, no lo presenta como no visto y deja reintentar la lectura', async () => {
    const user = userEvent.setup();
    let fallar = true;
    responderVisto(
      () => Promise.resolve(jsonResponse({ watched: false })),
      () =>
        Promise.resolve(
          fallar
            ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
            : jsonResponse({ watched: true }),
        ),
    );

    const m = await abrirDetalle();

    expect(await m.findByRole('alert')).toHaveTextContent(
      'No pudimos saber si ya viste este partido. Intentá de nuevo.',
    );
    expect(m.queryByRole('button', { name: /visto/i })).not.toBeInTheDocument();

    fallar = false;
    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    expect(await m.findByRole('button', { name: 'Deshacer visto' })).toBeEnabled();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(lecturasVisto()).toHaveLength(2);
  });

  it('una lectura con 401 ofrece reingresar con el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    responderVisto(
      () => Promise.resolve(jsonResponse({ watched: true })),
      () => Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)),
    );

    const m = await abrirDetalle();

    expect(await m.findByRole('alert')).toHaveTextContent(
      'La sesión venció. Iniciá sesión nuevamente.',
    );
    expect(m.queryByRole('button', { name: /visto/i })).not.toBeInTheDocument();

    await user.click(m.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('al cambiar de usuario vuelve a leer con su bearer y no conserva el estado del anterior', async () => {
    const otraSesion = {
      access_token: 'token-otro',
      user: { id: 'user-2', email: 'c@d.com' },
    } as Session;
    responderVisto(
      () => Promise.resolve(jsonResponse({ watched: true })),
      (init) =>
        Promise.resolve(
          jsonResponse({
            watched: new Headers(init?.headers).get('Authorization') === 'Bearer token-123',
          }),
        ),
    );

    const m = await abrirDetalle();
    await m.findByRole('button', { name: 'Deshacer visto' });

    const [[alCambiarSesion]] = authMock.onAuthStateChange.mock.calls as [
      [(evento: string, sesion: Session | null) => void],
    ];
    act(() => alCambiarSesion('SIGNED_IN', otraSesion));

    expect(await m.findByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    const ultimaLectura = lecturasVisto().at(-1)!;
    expect(new Headers(ultimaLectura[1].headers).get('Authorization')).toBe('Bearer token-otro');
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

describe('Cambio de partido (WAT-205)', () => {
  const partidoB = {
    ...partido,
    id: 'match-002',
    homeTeam: 'Racing Club',
    homeTeamId: 'team-racing-club',
    awayTeam: 'Independiente',
    awayTeamId: 'team-independiente',
  };
  const URL_A = `${API_BASE}/matches/match-001`;
  const URL_B = `${API_BASE}/matches/match-002`;
  const URL_SALA_A = `${URL_A}/room`;
  const URL_SALA_B = `${URL_B}/room`;
  const TITULO_A = 'River Plate vs. Boca Juniors';
  const TITULO_B = 'Racing Club vs. Independiente';

  type Pendiente = (respuesta: Response) => void;
  let pendientes: Map<string, Pendiente[]>;

  /**
   * Cada pedido queda pendiente hasta que la prueba lo resuelve. El doble
   * ignora la señal de abort a propósito: la pantalla tiene que descartar
   * las respuestas tardías por su cuenta.
   */
  beforeEach(() => {
    pendientes = new Map();
    fetchSpy.mockImplementation(
      (url: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          const clave = String(url);
          pendientes.set(clave, [...(pendientes.get(clave) ?? []), resolve]);
        }),
    );
  });

  async function responder(url: string, body: unknown, status = 200) {
    await waitFor(() => expect(pendientes.get(url)?.length).toBeGreaterThan(0));
    const [primero, ...resto] = pendientes.get(url)!;
    pendientes.set(url, resto);

    await act(async () => {
      primero!(jsonResponse(body, status));
    });
  }

  function SondaSala() {
    const { roomId } = useParams<{ roomId: string }>();
    return <h1>Sala {roomId}</h1>;
  }

  function renderConNavegacion() {
    return render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/matches/match-001']}>
          <nav>
            <Link to="/matches/match-002">Ir al partido B</Link>
            <Link to="/fuera">Salir del detalle</Link>
          </nav>
          <Routes>
            <Route path="/matches/:matchId" element={<MatchDetailPage />} />
            <Route path="/rooms/:roomId" element={<SondaSala />} />
            <Route path="/fuera" element={<h1>Fuera del detalle</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  async function abrirA() {
    renderConNavegacion();
    await responder(URL_A, { match: partido });
    await screen.findByRole('heading', { level: 1, name: TITULO_A });
  }

  it('al pasar de A a B muestra la carga y nada de A hasta que llega B', async () => {
    const user = userEvent.setup();
    await abrirA();

    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Detalle del partido');
    expect(screen.getByRole('status')).toHaveTextContent('Cargando el partido…');
    expect(screen.queryByText(TITULO_A)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entrar a la sala' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar como visto' })).not.toBeInTheDocument();

    await responder(URL_B, { match: partidoB });

    expect(await screen.findByRole('heading', { level: 1, name: TITULO_B })).toBeInTheDocument();
  });

  it('una respuesta tardía del detalle de A no pisa a B', async () => {
    const user = userEvent.setup();
    renderConNavegacion();
    await waitFor(() => expect(pendientes.get(URL_A)).toHaveLength(1));

    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    await responder(URL_B, { match: partidoB });
    await screen.findByRole('heading', { level: 1, name: TITULO_B });

    await responder(URL_A, { match: partido });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TITULO_B);
    expect(screen.queryByText(TITULO_A)).not.toBeInTheDocument();
  });

  it('la respuesta tardía de entrar a la sala de A no navega ni deja B en espera', async () => {
    const user = userEvent.setup();
    await abrirA();
    await user.click(screen.getByRole('button', { name: 'Entrar a la sala' }));

    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    await responder(URL_B, { match: partidoB });

    const entrarB = await screen.findByRole('button', { name: 'Entrar a la sala' });
    expect(entrarB).toBeEnabled();
    expect(entrarB).not.toHaveAttribute('aria-busy', 'true');

    await responder(URL_SALA_A, {
      room: { id: 'room-a', matchId: 'match-001', createdAt: '2026-09-18T21:00:00.000Z' },
    });

    expect(screen.queryByRole('heading', { name: /^Sala / })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TITULO_B);
  });

  it('el error de sala de A no se muestra en B', async () => {
    const user = userEvent.setup();
    await abrirA();
    await user.click(screen.getByRole('button', { name: 'Entrar a la sala' }));
    await responder(URL_SALA_A, { error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await responder(URL_B, { match: partidoB });
    await screen.findByRole('heading', { level: 1, name: TITULO_B });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('un error vigente al entrar a la sala de B se sigue avisando', async () => {
    const user = userEvent.setup();
    await abrirA();
    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    await responder(URL_B, { match: partidoB });

    await user.click(await screen.findByRole('button', { name: 'Entrar a la sala' }));
    await responder(URL_SALA_B, { error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos abrir la sala. Intentá de nuevo.',
    );
    expect(screen.getByRole('button', { name: 'Entrar a la sala' })).toBeEnabled();
  });

  it('la lectura tardía del visto de A no pisa el estado de B (WAT-179)', async () => {
    const user = userEvent.setup();
    await abrirA();
    await waitFor(() => expect(pendientes.get(`${URL_A}/watched`)).toHaveLength(1));

    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    await responder(URL_B, { match: partidoB });
    await responder(`${URL_B}/watched`, { watched: false });
    await screen.findByRole('button', { name: 'Marcar como visto' });

    await responder(`${URL_A}/watched`, { watched: true });

    expect(screen.getByRole('button', { name: 'Marcar como visto' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Deshacer visto' })).not.toBeInTheDocument();
  });

  it('la respuesta tardía de marcar A no cambia ni bloquea el visto de B (WAT-179)', async () => {
    const user = userEvent.setup();
    await abrirA();
    await responder(`${URL_A}/watched`, { watched: false });
    await user.click(await screen.findByRole('button', { name: 'Marcar como visto' }));

    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    await responder(URL_B, { match: partidoB });
    await responder(`${URL_B}/watched`, { watched: false });
    const marcarB = await screen.findByRole('button', { name: 'Marcar como visto' });

    await responder(`${URL_A}/watched`, { watched: true });

    expect(marcarB).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Deshacer visto' })).not.toBeInTheDocument();
  });

  it('al desmontar con el detalle y la sala pendientes descarta ambas respuestas', async () => {
    const user = userEvent.setup();
    await abrirA();
    await user.click(screen.getByRole('button', { name: 'Entrar a la sala' }));
    // Reintento de detalle en curso: no hay forma de dejarlo pendiente desde
    // la UI con el detalle ya cargado, así que se cubre con B sin responder.
    await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
    await waitFor(() => expect(pendientes.get(URL_B)).toHaveLength(1));

    await user.click(screen.getByRole('link', { name: 'Salir del detalle' }));
    await responder(URL_B, { match: partidoB });
    await responder(URL_SALA_A, {
      room: { id: 'room-a', matchId: 'match-001', createdAt: '2026-09-18T21:00:00.000Z' },
    });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fuera del detalle');
    expect(screen.queryByRole('heading', { name: /^Sala / })).not.toBeInTheDocument();
  });
  describe('calificación (WAT-213)', () => {
    const finalizadoA = { ...partido, status: 'finished' };
    const finalizadoB = { ...partidoB, status: 'finished' };

    /** Abre A finalizado y visto, con la lectura de su nota todavía pendiente. */
    async function abrirAConNotaPendiente() {
      renderConNavegacion();
      await responder(URL_A, { match: finalizadoA });
      await responder(`${URL_A}/watched`, { watched: true });
      await waitFor(() => expect(pendientes.get(`${URL_A}/rating`)).toHaveLength(1));
    }

    async function irABVistoSinNota() {
      await responder(URL_B, { match: finalizadoB });
      await responder(`${URL_B}/watched`, { watched: true });
      await responder(`${URL_B}/rating`, { rating: null });
      await screen.findByText('Todavía no calificaste este partido.');
    }

    it('la lectura tardía de la nota de A no pisa a B', async () => {
      const user = userEvent.setup();
      await abrirAConNotaPendiente();

      await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
      await irABVistoSinNota();

      await responder(`${URL_A}/rating`, { rating: 5 });

      expect(screen.getByRole('button', { name: '5 de 5' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByText('Todavía no calificaste este partido.')).toBeInTheDocument();
    });

    it('la respuesta tardía de guardar en A no cambia ni bloquea la calificación de B', async () => {
      const user = userEvent.setup();
      renderConNavegacion();
      await responder(URL_A, { match: finalizadoA });
      await responder(`${URL_A}/watched`, { watched: true });
      await responder(`${URL_A}/rating`, { rating: null });
      await user.click(await screen.findByRole('button', { name: '5 de 5' }));
      await waitFor(() => expect(pendientes.get(`${URL_A}/rating`)).toHaveLength(1));

      await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
      await irABVistoSinNota();

      await responder(`${URL_A}/rating`, { rating: 5 });

      const cincoB = screen.getByRole('button', { name: '5 de 5' });
      expect(cincoB).toHaveAttribute('aria-pressed', 'false');
      expect(cincoB).toHaveAttribute('aria-disabled', 'false');
      expect(screen.queryByText(/guardada/i)).not.toBeInTheDocument();
    });

    it('el error tardío de guardar en A no se muestra en B', async () => {
      const user = userEvent.setup();
      renderConNavegacion();
      await responder(URL_A, { match: finalizadoA });
      await responder(`${URL_A}/watched`, { watched: true });
      await responder(`${URL_A}/rating`, { rating: null });
      await user.click(await screen.findByRole('button', { name: '5 de 5' }));
      await waitFor(() => expect(pendientes.get(`${URL_A}/rating`)).toHaveLength(1));

      await user.click(screen.getByRole('link', { name: 'Ir al partido B' }));
      await irABVistoSinNota();

      await responder(`${URL_A}/rating`, { error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);

      expect(
        screen.queryByText('No pudimos guardar tu calificación. Intentá de nuevo.'),
      ).not.toBeInTheDocument();
    });
  });
});

describe('Calificación del partido (WAT-213)', () => {
  const URL_PARTIDO = `${API_BASE}/matches/match-001`;
  const URL_VISTO = `${URL_PARTIDO}/watched`;
  const URL_NOTA = `${URL_PARTIDO}/rating`;
  const URL_RESUMEN = `${URL_PARTIDO}/rating-summary`;

  interface OpcionesServidor {
    status?: string;
    visto?: boolean;
    nota?: number | null;
    /** Notas de OTRAS personas: con la propia forman el resumen que calcula el servidor. */
    otros?: number[];
    /** Reemplaza la lectura del visto (por ejemplo, para dejarla pendiente o fallar). */
    lecturaVisto?: (init?: RequestInit) => Promise<Response>;
    lecturaNota?: (init?: RequestInit) => Promise<Response>;
    /** Recibe el número de pedido (1, 2…) para poder fallar sólo el segundo. */
    lecturaResumen?: (pedido: number, init?: RequestInit) => Promise<Response>;
    guardadoNota?: (rating: number, init?: RequestInit) => Promise<Response>;
  }

  /**
   * Servidor en memoria: el detalle, el visto (GET/PUT/DELETE) y la nota
   * (GET/PUT) persisten como la API real, así las pruebas siguen el flujo
   * completo sin acoplarse al orden de los pedidos.
   */
  function servidor({
    status = 'finished',
    visto: vistoInicial = true,
    nota: notaInicial = null,
    otros = [],
    lecturaVisto,
    lecturaNota,
    lecturaResumen,
    guardadoNota,
  }: OpcionesServidor = {}) {
    let visto = vistoInicial;
    let nota = notaInicial;
    let lecturasResumen = 0;

    fetchSpy.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      const destino = String(url);
      const metodo = init?.method ?? 'GET';

      if (destino === URL_PARTIDO) {
        return Promise.resolve(jsonResponse({ match: { ...partido, status } }));
      }

      if (destino === URL_VISTO) {
        if (metodo === 'GET') {
          return lecturaVisto
            ? lecturaVisto(init)
            : Promise.resolve(jsonResponse({ watched: visto }));
        }
        visto = metodo === 'PUT';
        return Promise.resolve(jsonResponse({ watched: visto }));
      }

      if (destino === URL_NOTA) {
        if (metodo === 'GET') {
          return lecturaNota ? lecturaNota(init) : Promise.resolve(jsonResponse({ rating: nota }));
        }
        const pedida = (JSON.parse(String(init?.body)) as { rating: number }).rating;
        if (guardadoNota) return guardadoNota(pedida, init);
        nota = pedida;
        return Promise.resolve(jsonResponse({ rating: nota }));
      }

      if (destino === URL_RESUMEN) {
        lecturasResumen += 1;
        if (lecturaResumen) return lecturaResumen(lecturasResumen, init);

        // Como la base: cuenta y promedia a todas las personas, la propia incluida.
        const votos = nota === null ? otros : [...otros, nota];
        const promedio = votos.reduce((suma, valor) => suma + valor, 0) / votos.length;

        return Promise.resolve(
          jsonResponse({
            average: votos.length === 0 ? null : Math.round(promedio * 100) / 100,
            count: votos.length,
          }),
        );
      }

      return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: 'x' } }, 404));
    });
  }

  function pedidosNota(): [string, RequestInit][] {
    return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
      ([url]) => String(url) === URL_NOTA,
    );
  }

  function pedidosResumen(): [string, RequestInit][] {
    return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
      ([url]) => String(url) === URL_RESUMEN,
    );
  }

  function guardadosNota(): [string, RequestInit][] {
    return pedidosNota().filter(([, init]) => init.method === 'PUT');
  }

  async function abrirDetalle() {
    renderAt('/matches/match-001');
    return detalle();
  }

  describe('elegibilidad', () => {
    it('finalizado y visto: lee la nota con GET y bearer y ofrece el selector', async () => {
      servidor({ nota: 4 });

      const m = await abrirDetalle();

      expect(await m.findByRole('button', { name: '4 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(m.getByRole('heading', { level: 2, name: 'Calificá el partido' })).toBeInTheDocument();
      const [url, init] = pedidosNota()[0]!;
      expect(url).toBe(URL_NOTA);
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-123');
    });

    it('finalizado y visto, sin nota: muestra el selector y el aviso de ausencia', async () => {
      servidor({ nota: null });

      const m = await abrirDetalle();

      expect(await m.findByText('Todavía no calificaste este partido.')).toBeInTheDocument();
      expect(m.getAllByRole('button', { name: /de 5$/ })).toHaveLength(5);
    });

    it('finalizado pero no visto: no ofrece calificar, indica el paso que falta y no pide la nota', async () => {
      servidor({ visto: false });

      const m = await abrirDetalle();

      expect(
        await m.findByText('Marcá el partido como visto para poder calificarlo.'),
      ).toBeInTheDocument();
      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
      expect(pedidosNota()).toHaveLength(0);
    });

    it.each(['scheduled', 'live', 'postponed', 'cancelled'])(
      'partido %s, aunque esté marcado como visto: no ofrece calificar ni pide la nota',
      async (status) => {
        servidor({ status, visto: true });

        const m = await abrirDetalle();
        await m.findByRole('button', { name: 'Deshacer visto' });

        expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
        expect(m.queryByText(/calificar/i)).not.toBeInTheDocument();
        expect(pedidosNota()).toHaveLength(0);
      },
    );

    it('mientras se desconoce «visto» no ofrece calificar ni lo da por no visto', async () => {
      servidor({ lecturaVisto: () => new Promise<Response>(() => {}) });

      const m = await abrirDetalle();
      await m.findByText('Consultando si ya viste este partido…');

      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
      expect(m.queryByText(/marcá el partido como visto/i)).not.toBeInTheDocument();
      expect(pedidosNota()).toHaveLength(0);
    });

    it('si falla la lectura de «visto» no ofrece calificar', async () => {
      servidor({
        lecturaVisto: () =>
          Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)),
      });

      const m = await abrirDetalle();
      await m.findByRole('button', { name: 'Reintentar' });

      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
      expect(pedidosNota()).toHaveLength(0);
    });

    it('marcar como visto habilita calificar y deshacerlo lo retira', async () => {
      servidor({ visto: false, nota: 3 });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: 'Marcar como visto' }));

      expect(await m.findByRole('button', { name: '3 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await user.click(m.getByRole('button', { name: 'Deshacer visto' }));

      await waitFor(() =>
        expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument(),
      );
      expect(
        m.getByText('Marcá el partido como visto para poder calificarlo.'),
      ).toBeInTheDocument();
    });

    it('no agrega reseñas ni calificaciones de jugadores', async () => {
      servidor({ nota: null });

      const m = await abrirDetalle();
      await m.findByText('Todavía no calificaste este partido.');

      expect(m.queryByRole('textbox')).not.toBeInTheDocument();
      expect(m.queryByText(/reseña|jugador/i)).not.toBeInTheDocument();
      expect(m.getAllByRole('button', { name: /de 5$/ })).toHaveLength(5);
    });
  });

  describe('estados', () => {
    it('anuncia la carga de la nota y no ofrece ninguna acción mientras tanto', async () => {
      servidor({ lecturaNota: () => new Promise<Response>(() => {}) });

      const m = await abrirDetalle();

      expect(await m.findByText('Consultando tu calificación…')).toBeInTheDocument();
      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
      expect(m.queryByText('Todavía no calificaste este partido.')).not.toBeInTheDocument();
    });

    it('un error al leer la nota avisa, no lo presenta como sin calificar y deja reintentar', async () => {
      let intento = 0;
      servidor({
        nota: 2,
        lecturaNota: () => {
          intento += 1;
          return Promise.resolve(
            intento === 1
              ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
              : jsonResponse({ rating: 2 }),
          );
        },
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();

      expect(
        await m.findByText('No pudimos cargar tu calificación. Intentá de nuevo.'),
      ).toBeInTheDocument();
      expect(m.queryByText('Todavía no calificaste este partido.')).not.toBeInTheDocument();

      const reintentos = m.getAllByRole('button', { name: 'Reintentar' });
      await user.click(reintentos.at(-1)!);

      expect(await m.findByRole('button', { name: '2 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  describe('guardar y editar', () => {
    it('guarda con PUT, bearer y cuerpo { rating }, y anuncia el guardado', async () => {
      servidor({ nota: null });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '5 de 5' }));

      expect(await m.findByText('Calificación guardada: 5 de 5.')).toBeInTheDocument();
      expect(m.getByRole('button', { name: '5 de 5' })).toHaveAttribute('aria-pressed', 'true');
      const [url, init] = guardadosNota()[0]!;
      expect(url).toBe(URL_NOTA);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-123');
      expect(JSON.parse(String(init.body))).toEqual({ rating: 5 });
    });

    it('edita la nota existente y deja la nueva como única marcada', async () => {
      servidor({ nota: 4 });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '2 de 5' }));

      expect(await m.findByText('Calificación guardada: 2 de 5.')).toBeInTheDocument();
      expect(m.getByRole('button', { name: '2 de 5' })).toHaveAttribute('aria-pressed', 'true');
      expect(m.getByRole('button', { name: '4 de 5' })).toHaveAttribute('aria-pressed', 'false');
      expect(guardadosNota()).toHaveLength(1);
    });

    it('guardar, recargar y volver a abrir muestran la nota persistida', async () => {
      servidor({ nota: null });
      const user = userEvent.setup();

      const primera = await abrirDetalle();
      await user.click(await primera.findByRole('button', { name: '3 de 5' }));
      await primera.findByText('Calificación guardada: 3 de 5.');
      cleanup();

      const recargada = await abrirDetalle();

      expect(await recargada.findByRole('button', { name: '3 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(recargada.getByText('Tu calificación: 3 de 5.')).toBeInTheDocument();
    });

    it('mientras guarda no acepta más envíos: doble clic y otra nota generan un único PUT', async () => {
      let resolver!: (respuesta: Response) => void;
      servidor({
        nota: null,
        guardadoNota: () => new Promise<Response>((resolve) => (resolver = resolve)),
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.dblClick(await m.findByRole('button', { name: '5 de 5' }));
      await user.click(m.getByRole('button', { name: '1 de 5' }));

      expect(guardadosNota()).toHaveLength(1);
      expect(m.getByText('Guardando tu calificación…')).toBeInTheDocument();

      await act(async () => resolver(jsonResponse({ rating: 5 })));

      expect(await m.findByText('Calificación guardada: 5 de 5.')).toBeInTheDocument();
    });

    it('muestra la nota que confirma el servidor, no la que se pidió', async () => {
      servidor({ nota: null, guardadoNota: () => Promise.resolve(jsonResponse({ rating: 3 })) });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '5 de 5' }));

      expect(await m.findByText('Calificación guardada: 3 de 5.')).toBeInTheDocument();
      expect(m.getByRole('button', { name: '3 de 5' })).toHaveAttribute('aria-pressed', 'true');
      expect(m.getByRole('button', { name: '5 de 5' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('un error de la API avisa, conserva la última nota confirmada y deja reintentar', async () => {
      let intento = 0;
      servidor({
        nota: 4,
        guardadoNota: (rating) => {
          intento += 1;
          return Promise.resolve(
            intento === 1
              ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
              : jsonResponse({ rating }),
          );
        },
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '2 de 5' }));

      expect(
        await m.findByText('No pudimos guardar tu calificación. Intentá de nuevo.'),
      ).toBeInTheDocument();
      expect(m.getByRole('button', { name: '4 de 5' })).toHaveAttribute('aria-pressed', 'true');
      expect(m.getByRole('button', { name: '2 de 5' })).toHaveAttribute('aria-pressed', 'false');

      await user.click(m.getByRole('button', { name: '2 de 5' }));

      expect(await m.findByText('Calificación guardada: 2 de 5.')).toBeInTheDocument();
      expect(
        m.queryByText('No pudimos guardar tu calificación. Intentá de nuevo.'),
      ).not.toBeInTheDocument();
    });

    it('un 409 (el partido dejó de ser calificable) se avisa con su propio mensaje', async () => {
      servidor({
        nota: null,
        guardadoNota: () =>
          Promise.resolve(jsonResponse({ error: { code: 'CONFLICT', message: 'x' } }, 409)),
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '5 de 5' }));

      expect(
        await m.findByText('Sólo se puede calificar un partido finalizado y marcado como visto.'),
      ).toBeInTheDocument();
      expect(m.getByRole('button', { name: '5 de 5' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('una caída de red al guardar avisa y no cambia la nota', async () => {
      servidor({ nota: 4, guardadoNota: () => Promise.reject(new TypeError('Failed to fetch')) });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '1 de 5' }));

      expect(await m.findByText(/No pudimos conectarnos/)).toBeInTheDocument();
      expect(m.getByRole('button', { name: '4 de 5' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('ante un 401 al guardar ofrece reingresar con el flujo de Auth existente', async () => {
      servidor({
        nota: null,
        guardadoNota: () =>
          Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)),
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      await user.click(await m.findByRole('button', { name: '5 de 5' }));
      const reingresar = await m.findAllByRole('button', { name: 'Iniciar sesión nuevamente' });
      await user.click(reingresar.at(-1)!);

      expect(authMock.signOut).toHaveBeenCalledTimes(1);
    });
  });

  describe('teclado', () => {
    it('se opera con el teclado: Tab llega al selector, Enter guarda y Espacio edita', async () => {
      servidor({ nota: null });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      const uno = await m.findByRole('button', { name: '1 de 5' });
      uno.focus();

      await user.keyboard('{Enter}');
      expect(await m.findByText('Calificación guardada: 1 de 5.')).toBeInTheDocument();

      await user.tab();
      await user.keyboard(' ');
      expect(await m.findByText('Calificación guardada: 2 de 5.')).toBeInTheDocument();
      expect(guardadosNota()).toHaveLength(2);
    });
  });

  describe('cambio de usuario', () => {
    it('vuelve a leer con su bearer y no conserva la nota del anterior', async () => {
      const otraSesion = {
        access_token: 'token-otro',
        user: { id: 'user-2', email: 'c@d.com' },
      } as Session;
      servidor({
        lecturaNota: (init) =>
          Promise.resolve(
            jsonResponse({
              rating:
                new Headers(init?.headers).get('Authorization') === 'Bearer token-123' ? 5 : null,
            }),
          ),
      });

      const m = await abrirDetalle();
      expect(await m.findByRole('button', { name: '5 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      const [[alCambiarSesion]] = authMock.onAuthStateChange.mock.calls as [
        [(evento: string, sesion: Session | null) => void],
      ];
      act(() => alCambiarSesion('SIGNED_IN', otraSesion));

      expect(await m.findByText('Todavía no calificaste este partido.')).toBeInTheDocument();
      expect(m.getByRole('button', { name: '5 de 5' })).toHaveAttribute('aria-pressed', 'false');
      const ultimaLectura = pedidosNota().at(-1)!;
      expect(new Headers(ultimaLectura[1].headers).get('Authorization')).toBe('Bearer token-otro');
    });

    it('el «visto» del usuario anterior no habilita calificar al nuevo', async () => {
      const otraSesion = {
        access_token: 'token-otro',
        user: { id: 'user-2', email: 'c@d.com' },
      } as Session;
      let resolverLecturaNuevoUsuario!: (respuesta: Response) => void;
      servidor({
        nota: 4,
        lecturaVisto: (init) =>
          new Promise<Response>((resolve) => {
            const esNuevo = new Headers(init?.headers).get('Authorization') === 'Bearer token-otro';
            if (esNuevo) resolverLecturaNuevoUsuario = resolve;
            else resolve(jsonResponse({ watched: true }));
          }),
      });

      const m = await abrirDetalle();
      await m.findByRole('button', { name: '4 de 5' });

      const [[alCambiarSesion]] = authMock.onAuthStateChange.mock.calls as [
        [(evento: string, sesion: Session | null) => void],
      ];
      act(() => alCambiarSesion('SIGNED_IN', otraSesion));

      await m.findByText('Consultando si ya viste este partido…');
      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
      // Ni siquiera se pide la nota con el bearer del usuario nuevo: el «visto»
      // del anterior no cuenta, aunque el estado del detalle todavía lo tenga.
      expect(
        pedidosNota().filter(
          ([, init]) => new Headers(init.headers).get('Authorization') === 'Bearer token-otro',
        ),
      ).toHaveLength(0);

      await act(async () => resolverLecturaNuevoUsuario(jsonResponse({ watched: false })));

      expect(
        await m.findByText('Marcá el partido como visto para poder calificarlo.'),
      ).toBeInTheDocument();
      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
    });
  });

  describe('resumen de la comunidad (WAT-215)', () => {
    const resumen = async (m: Awaited<ReturnType<typeof detalle>>) =>
      within(await m.findByRole('region', { name: 'Calificación de la comunidad' }));

    it('finalizado: lee el resumen con GET y bearer y muestra el promedio y la cantidad', async () => {
      servidor({ otros: [3, 4, 4, 5] });

      const m = await abrirDetalle();
      const r = await resumen(m);

      expect(await r.findByText('4,0')).toBeInTheDocument();
      expect(r.getByText('de 5 (4 votos)')).toBeInTheDocument();
      const [url, init] = pedidosResumen()[0]!;
      expect(url).toBe(URL_RESUMEN);
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-123');
      expect(pedidosResumen()).toHaveLength(1);
    });

    it('un único voto va en singular', async () => {
      servidor({ otros: [5] });

      const r = await resumen(await abrirDetalle());

      expect(await r.findByText('5,0')).toBeInTheDocument();
      expect(r.getByText('de 5 (1 voto)')).toBeInTheDocument();
    });

    it('sin votos muestra un estado explícito, no «0 votos» ni un promedio', async () => {
      servidor({ otros: [], nota: null });

      const r = await resumen(await abrirDetalle());

      expect(
        await r.findByText('Todavía no hay calificaciones para este partido.'),
      ).toBeInTheDocument();
      expect(r.queryByText(/voto/)).not.toBeInTheDocument();
      expect(r.queryByText(/de 5/)).not.toBeInTheDocument();
    });

    it.each(['scheduled', 'live', 'postponed', 'cancelled'])(
      'con el partido en estado %s no hay resumen ni se pide',
      async (status) => {
        servidor({ status, otros: [4] });

        const m = await abrirDetalle();
        await m.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' });

        expect(
          m.queryByRole('region', { name: 'Calificación de la comunidad' }),
        ).not.toBeInTheDocument();
        expect(pedidosResumen()).toHaveLength(0);
      },
    );

    it('se muestra aunque la persona no haya marcado el partido como visto ni lo haya calificado', async () => {
      servidor({ visto: false, nota: null, otros: [2, 3] });

      const m = await abrirDetalle();
      const r = await resumen(m);

      expect(await r.findByText('2,5')).toBeInTheDocument();
      expect(m.queryByRole('button', { name: /de 5$/ })).not.toBeInTheDocument();
    });

    it('mientras lee anuncia la carga sin ofrecer acciones ni mostrar un cero', async () => {
      servidor({ lecturaResumen: () => new Promise<Response>(() => {}) });

      const m = await abrirDetalle();
      const r = await resumen(m);

      expect(await r.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
      expect(r.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
      expect(r.queryByText(/voto/)).not.toBeInTheDocument();
    });

    it('un error del servidor no se muestra como cero votos y no tapa el resto del detalle', async () => {
      servidor({
        nota: 3,
        lecturaResumen: () =>
          Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)),
      });

      const m = await abrirDetalle();
      const r = await resumen(m);

      expect(await r.findByRole('alert')).toHaveTextContent(
        'No pudimos cargar el promedio de calificaciones. Intentá de nuevo.',
      );
      expect(r.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
      expect(r.queryByText(/voto/)).not.toBeInTheDocument();
      expect(await m.findByRole('button', { name: '3 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        m.getByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
      ).toBeInTheDocument();
    });

    it('«Reintentar» vuelve a pedir el resumen y lo muestra', async () => {
      servidor({
        otros: [4, 5],
        lecturaResumen: (pedido) =>
          pedido === 1
            ? Promise.resolve(
                jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
              )
            : Promise.resolve(jsonResponse({ average: 4.5, count: 2 })),
      });
      const user = userEvent.setup();

      const r = await resumen(await abrirDetalle());
      await user.click(await r.findByRole('button', { name: 'Reintentar' }));

      expect(await r.findByText('4,5')).toBeInTheDocument();
      expect(r.queryByRole('alert')).not.toBeInTheDocument();
      expect(pedidosResumen()).toHaveLength(2);
    });

    it('un 401 ofrece reingresar y cierra la sesión por el flujo de Auth', async () => {
      servidor({
        lecturaResumen: () =>
          Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)),
      });
      const user = userEvent.setup();

      const r = await resumen(await abrirDetalle());
      await user.click(await r.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

      expect(authMock.signOut).toHaveBeenCalledTimes(1);
    });

    it('al guardar la propia nota el resumen se vuelve a pedir y refleja el voto nuevo', async () => {
      servidor({ nota: null, otros: [5, 5] });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      const r = await resumen(m);
      expect(await r.findByText('5,0')).toBeInTheDocument();
      expect(r.getByText('de 5 (2 votos)')).toBeInTheDocument();

      await user.click(await m.findByRole('button', { name: '1 de 5' }));

      expect(await r.findByText('3,67')).toBeInTheDocument();
      expect(r.getByText('de 5 (3 votos)')).toBeInTheDocument();
      expect(pedidosResumen()).toHaveLength(2);
    });

    it('al editar la propia nota cambia el promedio pero no suma otro voto', async () => {
      servidor({ nota: 1, otros: [5, 5] });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      const r = await resumen(m);
      expect(await r.findByText('3,67')).toBeInTheDocument();
      expect(r.getByText('de 5 (3 votos)')).toBeInTheDocument();

      await user.click(await m.findByRole('button', { name: '5 de 5' }));

      expect(await r.findByText('5,0')).toBeInTheDocument();
      expect(r.getByText('de 5 (3 votos)')).toBeInTheDocument();
      expect(pedidosResumen()).toHaveLength(2);
    });

    it('un guardado que falla no vuelve a pedir el resumen', async () => {
      servidor({
        nota: 2,
        otros: [4],
        guardadoNota: () =>
          Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)),
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      const r = await resumen(m);
      await r.findByText('3,0');

      await user.click(await m.findByRole('button', { name: '5 de 5' }));
      await m.findAllByRole('alert');

      expect(pedidosResumen()).toHaveLength(1);
      expect(r.getByText('3,0')).toBeInTheDocument();
    });

    it('primer voto con la consulta del resumen pendiente: no conviven «guardada» y «sin calificaciones»', async () => {
      let resolverSegundo!: (respuesta: Response) => void;
      servidor({
        nota: null,
        otros: [],
        lecturaResumen: (pedido) =>
          pedido === 1
            ? Promise.resolve(jsonResponse({ average: null, count: 0 }))
            : new Promise<Response>((resolver) => {
                resolverSegundo = resolver;
              }),
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      const r = await resumen(m);
      await r.findByText('Todavía no hay calificaciones para este partido.');

      await user.click(await m.findByRole('button', { name: '1 de 5' }));

      expect(await m.findByText('Calificación guardada: 1 de 5.')).toBeInTheDocument();
      expect(await r.findByRole('status')).toHaveTextContent('Consultando las calificaciones…');
      expect(r.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();

      await act(async () => resolverSegundo(jsonResponse({ average: 1, count: 1 })));

      expect(await r.findByText('1,0')).toBeInTheDocument();
      expect(r.getByText('de 5 (1 voto)')).toBeInTheDocument();
      expect(r.queryByRole('status')).not.toBeInTheDocument();
    });

    it('si el resumen falla tras guardar avisa el error en vez de dejar el valor viejo como vigente', async () => {
      servidor({
        nota: null,
        otros: [5],
        lecturaResumen: (pedido) =>
          pedido === 1
            ? Promise.resolve(jsonResponse({ average: 5, count: 1 }))
            : Promise.resolve(
                jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
              ),
      });
      const user = userEvent.setup();

      const m = await abrirDetalle();
      const r = await resumen(m);
      await r.findByText('5,0');

      await user.click(await m.findByRole('button', { name: '2 de 5' }));

      expect(await r.findByRole('alert')).toBeInTheDocument();
      expect(r.queryByText('5,0')).not.toBeInTheDocument();
      expect(r.queryByText(/todavía no hay calificaciones/i)).not.toBeInTheDocument();
      // La nota propia ya se guardó: el fallo del resumen no la desconfirma.
      expect(await m.findByRole('button', { name: '2 de 5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('queda antes de la calificación propia y con su propio título de nivel 2', async () => {
      servidor({ otros: [4] });

      const m = await abrirDetalle();
      const comunidad = await m.findByRole('heading', {
        level: 2,
        name: 'Calificación de la comunidad',
      });
      const propia = await m.findByRole('heading', { level: 2, name: 'Calificá el partido' });

      expect(
        comunidad.compareDocumentPosition(propia) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe('vista móvil', () => {
    it('los botones miden 44 px (tamaño táctil) y el grupo permite que envuelvan', async () => {
      servidor({ nota: null });

      const m = await abrirDetalle();
      const grupo = await m.findByRole('group', { name: 'Calificá el partido' });

      expect(grupo).toHaveClass('flex', 'flex-wrap');
      for (const boton of within(grupo).getAllByRole('button')) {
        expect(boton).toHaveClass('size-11');
      }
    });
  });
});
