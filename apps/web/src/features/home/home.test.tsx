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
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
};

const racing = {
  id: 'match-racing-inde',
  homeTeam: 'Racing Club',
  homeTeamId: 'team-racing-club',
  awayTeam: 'Independiente',
  awayTeamId: 'team-independiente',
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

const PARTIDOS_URL = `${API_BASE}/matches`;
const PERFIL_URL = `${API_BASE}/me/profile`;

// La Home pide el catálogo y el perfil: cada prueba decide qué responde cada uno.
let responderAPartidos: () => Promise<Response>;
let responderAPerfil: () => Promise<Response>;

function responderPartidos(body: unknown, status = 200) {
  responderAPartidos = () => Promise.resolve(jsonResponse(body, status));
}

function partidosPendientes() {
  responderAPartidos = () => new Promise(() => {});
}

function partidosFallan() {
  responderAPartidos = () => Promise.reject(new TypeError('Failed to fetch'));
}

/** `null` es una respuesta legítima: la persona todavía no completó su perfil. */
function responderPerfil(favoriteTeamId: string | null | 'sin-perfil') {
  responderAPerfil = () =>
    Promise.resolve(
      jsonResponse({
        profile:
          favoriteTeamId === 'sin-perfil'
            ? null
            : { displayName: 'Martu', bio: '', favoriteTeamId },
      }),
    );
}

function llamadasA(url: string): [string, RequestInit][] {
  return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
    ([destino]) => String(destino) === url,
  );
}

function ultimaPeticion() {
  const calls = llamadasA(PARTIDOS_URL);
  return calls[calls.length - 1] as [string, RequestInit];
}

beforeEach(() => {
  vi.clearAllMocks();
  responderPartidos({ matches: [] });
  responderPerfil('sin-perfil');
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input: unknown) =>
      String(input) === PERFIL_URL ? responderAPerfil() : responderAPartidos(),
    );
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
    responderPartidos({ matches: [river, racing] });

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
    partidosPendientes();

    renderAt('/');

    const estado = await (await home()).findByRole('status');
    expect(estado).toHaveTextContent('Cargando partidos…');
  });

  it('consulta únicamente la Node API, con bearer', async () => {
    conSesion();
    responderPartidos({ matches: [river] });

    renderAt('/');
    await screen.findByRole('link', { name: /Ver partido/ });

    const [url, init] = ultimaPeticion();

    expect(url).toBe(PARTIDOS_URL);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
    expect(llamadasA(PARTIDOS_URL)).toHaveLength(1);
    for (const [destino] of fetchSpy.mock.calls as [string][]) {
      expect(String(destino).startsWith(API_BASE)).toBe(true);
    }
  });

  it('muestra una tarjeta por partido, en una lista semántica', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });

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
    responderPartidos({ matches: [river] });

    renderAt('/');

    expect(
      await screen.findByRole('link', { name: 'Ver partido: River Plate vs. Boca Juniors' }),
    ).toHaveAttribute('href', '/matches/match-river-boca');
  });

  it('explica la lista vacía en vez de dejar la pantalla en blanco', async () => {
    conSesion();
    responderPartidos({ matches: [] });

    renderAt('/');

    const m = await home();
    expect(await m.findByText(/Todavía no hay partidos disponibles/)).toBeInTheDocument();
    expect(m.queryByRole('list')).not.toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Sala del equipo favorito', () => {
  const SIN_FAVORITO = /Todavía no elegiste un equipo favorito/;
  const SIN_PARTIDO = /Tu equipo favorito no tiene partidos en vivo ni próximos/;
  const ENTRAR_A_RACING = 'Entrar a la sala del partido: Racing Club vs. Independiente';

  it('con favorito y partido relevante muestra una sola tarjeta de sala favorita', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderPerfil('team-racing-club');

    renderAt('/');
    const m = await home();

    expect(await m.findByRole('button', { name: ENTRAR_A_RACING })).toBeInTheDocument();
    expect(m.getAllByRole('button', { name: /Entrar a la sala/ })).toHaveLength(1);
    expect(m.queryByText(SIN_FAVORITO)).not.toBeInTheDocument();
    expect(m.queryByText(SIN_PARTIDO)).not.toBeInTheDocument();
    // El listado general sigue completo, con el partido del favorito incluido.
    expect(within(m.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('elige el próximo partido programado del favorito cuando no hay uno en vivo', async () => {
    const proximo = {
      ...river,
      id: 'match-river-proximo',
      kickoffAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    conSesion();
    // `river` ya empezó: programado en el pasado, no es un partido próximo.
    responderPartidos({ matches: [river, proximo, racing] });
    responderPerfil('team-river-plate');

    renderAt('/');
    const m = await home();

    expect(
      await m.findByRole('button', {
        name: 'Entrar a la sala del partido: River Plate vs. Boca Juniors',
      }),
    ).toBeInTheDocument();
    expect(m.getAllByRole('button', { name: /Entrar a la sala/ })).toHaveLength(1);
  });

  it.each([
    ['todavía no completó su perfil', 'sin-perfil' as const],
    ['su perfil no tiene equipo favorito', null],
  ])('sin favorito (%s) explica cómo elegirlo y lleva al perfil', async (_caso, favorito) => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderPerfil(favorito);

    renderAt('/');
    const m = await home();

    expect(await m.findByText(SIN_FAVORITO)).toBeInTheDocument();
    expect(m.getByRole('link', { name: 'Elegir equipo favorito' })).toHaveAttribute(
      'href',
      '/profile',
    );
    expect(m.queryByRole('button', { name: /Entrar a la sala/ })).not.toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(m.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('con favorito pero sin partido vivo ni próximo muestra otro mensaje y conserva el listado', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderPerfil('team-sin-partidos');

    renderAt('/');
    const m = await home();

    expect(await m.findByText(SIN_PARTIDO)).toBeInTheDocument();
    expect(m.queryByText(SIN_FAVORITO)).not.toBeInTheDocument();
    expect(m.queryByRole('link', { name: 'Elegir equipo favorito' })).not.toBeInTheDocument();
    expect(m.queryByRole('button', { name: /Entrar a la sala/ })).not.toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(m.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('con favorito y catálogo vacío muestra ambos mensajes, sin error', async () => {
    conSesion();
    responderPerfil('team-racing-club');

    renderAt('/');
    const m = await home();

    expect(await m.findByText(SIN_PARTIDO)).toBeInTheDocument();
    expect(m.getByText(/Todavía no hay partidos disponibles/)).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pide el perfil y el catálogo una sola vez, sin llamadas extra por la tarjeta ni el fallback', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderPerfil('team-racing-club');

    renderAt('/');
    await (await home()).findByRole('button', { name: ENTRAR_A_RACING });

    expect(llamadasA(PARTIDOS_URL)).toHaveLength(1);
    expect(llamadasA(PERFIL_URL)).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('mientras el perfil carga muestra el listado sin adelantar un fallback', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderAPerfil = () => new Promise(() => {});

    renderAt('/');
    const m = await home();

    expect(await m.findByRole('list')).toBeInTheDocument();
    expect(m.queryByText(SIN_FAVORITO)).not.toBeInTheDocument();
    expect(m.queryByText(SIN_PARTIDO)).not.toBeInTheDocument();
  });

  it('si el perfil falla no lo presenta como «sin favorito» y conserva el listado', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderAPerfil = () => Promise.reject(new TypeError('Failed to fetch'));

    renderAt('/');
    const m = await home();

    expect(await m.findByText('No pudimos cargar tu equipo favorito.')).toBeInTheDocument();
    expect(m.queryByText(SIN_FAVORITO)).not.toBeInTheDocument();
    expect(m.queryByText(SIN_PARTIDO)).not.toBeInTheDocument();
    expect(within(m.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('si el catálogo falla no muestra la sección del favorito', async () => {
    conSesion();
    partidosFallan();
    responderPerfil('team-racing-club');

    renderAt('/');
    const m = await home();

    await m.findByRole('alert');
    expect(m.queryByText(SIN_PARTIDO)).not.toBeInTheDocument();
    expect(m.queryByRole('button', { name: /Entrar a la sala/ })).not.toBeInTheDocument();
  });

  it('con la tarjeta montada el h1 de la página sigue siendo uno solo', async () => {
    conSesion();
    responderPartidos({ matches: [river, racing] });
    responderPerfil('team-racing-club');

    renderAt('/');
    await (await home()).findByRole('button', { name: ENTRAR_A_RACING });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('Errores y reintento', () => {
  it('una caída de red se anuncia como error, no como lista vacía', async () => {
    conSesion();
    partidosFallan();

    renderAt('/');

    const m = await home();
    const alerta = await m.findByRole('alert');

    expect(alerta).toHaveTextContent('No pudimos conectarnos.');
    expect(m.queryByText(/Todavía no hay partidos/)).not.toBeInTheDocument();
    expect(m.queryByRole('list')).not.toBeInTheDocument();
  });

  it('un 500 se anuncia como error recuperable', async () => {
    conSesion();
    responderPartidos({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error.' } }, 500);

    renderAt('/');

    const m = await home();
    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos cargar los partidos.');
    expect(m.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('el reintento vuelve a consultar la API y muestra el resultado', async () => {
    const user = userEvent.setup();
    conSesion();
    partidosFallan();

    renderAt('/');
    const m = await home();
    await m.findByRole('alert');

    responderPartidos({ matches: [river] });
    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    expect(await m.findByRole('link', { name: /Ver partido/ })).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(llamadasA(PARTIDOS_URL)).toHaveLength(2);
  });

  it('ante un 401 ofrece reingresar y usa el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    conSesion();
    responderPartidos({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401);

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
    partidosPendientes();

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
