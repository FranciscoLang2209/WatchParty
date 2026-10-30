import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'finished',
  score: { home: 2, away: 1 },
};

const racing = {
  id: 'match-racing-inde',
  homeTeam: 'Racing Club',
  homeTeamId: 'team-racing-club',
  awayTeam: 'Independiente',
  awayTeamId: 'team-independiente',
  kickoffAt: '2026-11-07T23:30:00Z',
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

const esBusqueda = (input: unknown) => String(input).includes('/matches/search');

function busquedas() {
  return fetchSpy.mock.calls.filter(([input]: [unknown]) => esBusqueda(input)) as [
    string,
    RequestInit,
  ][];
}

function responderBusqueda(body: unknown, status = 200) {
  fetchSpy.mockImplementation((input: unknown) =>
    Promise.resolve(esBusqueda(input) ? jsonResponse(body, status) : jsonResponse({ matches: [] })),
  );
}

async function pantalla() {
  authMock.getSession.mockResolvedValue({ data: { session }, error: null });
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/search']}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Buscar' });
  return within(screen.getByRole('main'));
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

function partido(n: number) {
  return {
    ...racing,
    id: `match-${n}`,
    homeTeam: `Local ${n}`,
    awayTeam: `Visitante ${n}`,
  };
}

const pagina = (desde: number, cantidad: number) =>
  Array.from({ length: cantidad }, (_, i) => partido(desde + i));

describe('Búsqueda: formulario', () => {
  it('muestra el campo con su etiqueta y el botón Buscar', async () => {
    const p = await pantalla();

    expect(p.getByRole('search')).toBeInTheDocument();
    expect(p.getByLabelText('Equipo')).toBeInTheDocument();
    expect(p.getByRole('button', { name: 'Buscar' })).toHaveAttribute('type', 'submit');
  });

  it('antes de buscar muestra la consulta vacía, distinta de «sin resultados»', async () => {
    const p = await pantalla();

    expect(p.getByText(/Escribí el nombre de un equipo y apretá Buscar/)).toBeInTheDocument();
    expect(p.queryByText(/No encontramos partidos/)).not.toBeInTheDocument();
    expect(p.queryByRole('status')).not.toBeInTheDocument();
  });

  it('no consulta nada al montar ni mientras se escribe', async () => {
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river');

    expect(busquedas()).toHaveLength(0);
    expect(p.queryByRole('status')).not.toBeInTheDocument();
  });

  it('consulta al apretar Buscar, con el texto recortado y el bearer', async () => {
    responderBusqueda({ matches: [river], nextCursor: null });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), '  river ');
    await user.click(p.getByRole('button', { name: 'Buscar' }));

    expect(await p.findByRole('heading', { name: 'River Plate vs. Boca Juniors' })).toBeVisible();
    expect(busquedas()).toHaveLength(1);

    const [url, init] = busquedas()[0]!;
    expect(url).toBe(`${API_BASE}/matches/search?q=river&limit=20`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-123');
  });

  it('consulta con Enter desde el campo', async () => {
    responderBusqueda({ matches: [river], nextCursor: null });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

    expect(await p.findByRole('heading', { name: 'River Plate vs. Boca Juniors' })).toBeVisible();
    expect(busquedas()).toHaveLength(1);
  });

  it('el texto con caracteres especiales viaja codificado, tal cual', async () => {
    responderBusqueda({ matches: [], nextCursor: null });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), '100%_*&a{Enter}');

    await waitFor(() => expect(busquedas()).toHaveLength(1));
    expect(new URL(busquedas()[0]![0]).searchParams.get('q')).toBe('100%_*&a');
  });

  it('un texto vacío o de espacios no consulta y avisa en el campo', async () => {
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), '   {Enter}');

    expect(await p.findByRole('alert')).toHaveTextContent('Escribí el nombre de un equipo');
    expect(p.getByLabelText('Equipo')).toHaveAttribute('aria-invalid', 'true');
    expect(p.getByLabelText('Equipo')).toHaveAccessibleDescription(/Escribí el nombre/);
    expect(busquedas()).toHaveLength(0);
  });

  it('el aviso del campo desaparece al volver a escribir', async () => {
    const user = userEvent.setup();
    const p = await pantalla();

    await user.click(p.getByRole('button', { name: 'Buscar' }));
    expect(await p.findByRole('alert')).toBeInTheDocument();

    await user.type(p.getByLabelText('Equipo'), 'r');

    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(p.getByLabelText('Equipo')).toHaveAttribute('aria-invalid', 'false');
  });

  it('el campo respeta el máximo de la API (100 caracteres)', async () => {
    const p = await pantalla();

    expect(p.getByLabelText('Equipo')).toHaveAttribute('maxlength', '100');
  });

  it('se recorre con el teclado: campo, luego botón, con foco visible', async () => {
    const user = userEvent.setup();
    const p = await pantalla();

    p.getByLabelText('Equipo').focus();
    expect(p.getByLabelText('Equipo').className).toMatch(/focus-visible:ring-2/);

    await user.tab();
    expect(p.getByRole('button', { name: 'Buscar' })).toHaveFocus();
    expect(p.getByRole('button', { name: 'Buscar' }).className).toMatch(/focus-visible:ring-2/);
  });
});

describe('Búsqueda: resultados', () => {
  it('lista los partidos con estado, equipos, marcador y fecha, y cuenta los resultados', async () => {
    responderBusqueda({ matches: [river, racing], nextCursor: null });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'a{Enter}');

    expect(await p.findByText('2 partidos para «a».')).toBeInTheDocument();
    expect(
      p.getByRole('link', { name: 'Ver partido: River Plate vs. Boca Juniors' }),
    ).toHaveAttribute('href', '/matches/match-river-boca');
    expect(p.getByRole('heading', { name: 'Racing Club vs. Independiente' })).toBeInTheDocument();
    expect(p.queryByText(/Hay más resultados/)).not.toBeInTheDocument();

    // El que tiene resultado lo muestra; el que no, destaca su horario.
    expect(p.getByText('Finalizado')).toBeInTheDocument();
    expect(p.getByText('Resultado: River Plate 2, Boca Juniors 1')).toBeInTheDocument();
    expect(p.getByText('Programado')).toBeInTheDocument();
    expect(p.getAllByText(/\d{2}:\d{2}/)).toHaveLength(2);
    expect(p.getAllByText(/Resultado:/)).toHaveLength(1);
  });

  it('cada resultado tiene un enlace con nombre propio, distinto del de los demás', async () => {
    responderBusqueda({ matches: [river, racing], nextCursor: null });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'a{Enter}');
    await p.findByText('2 partidos para «a».');

    expect(p.getAllByRole('link', { name: /^Ver partido: / })).toHaveLength(2);
    expect(
      p.getByRole('link', { name: 'Ver partido: Racing Club vs. Independiente' }),
    ).toHaveAttribute('href', '/matches/match-racing-inde');
  });

  it('abre el detalle del partido con un clic', async () => {
    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esBusqueda(input)
          ? jsonResponse({ matches: [river], nextCursor: null })
          : String(input).endsWith('/matches/match-river-boca')
            ? jsonResponse({ match: river })
            : jsonResponse({ matches: [] }),
      ),
    );
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
    await user.click(await p.findByRole('link', { name: /^Ver partido: River Plate/ }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
  });

  it('abre el detalle con el teclado: Tab hasta el enlace y Enter', async () => {
    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esBusqueda(input)
          ? jsonResponse({ matches: [river], nextCursor: null })
          : String(input).endsWith('/matches/match-river-boca')
            ? jsonResponse({ match: river })
            : jsonResponse({ matches: [] }),
      ),
    );
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
    const enlace = await p.findByRole('link', { name: /^Ver partido: River Plate/ });

    await user.tab(); // del campo al botón Buscar
    await user.tab(); // del botón al enlace del resultado
    expect(enlace).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
  });

  it('anuncia «Buscando…» mientras espera', async () => {
    fetchSpy.mockImplementation((input: unknown) =>
      esBusqueda(input) ? new Promise(() => {}) : Promise.resolve(jsonResponse({ matches: [] })),
    );
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

    expect(await p.findByRole('status')).toHaveTextContent('Buscando…');
    expect(p.getByRole('button', { name: 'Buscar' })).toHaveAttribute('aria-busy', 'true');
  });

  it('sin coincidencias lo dice explícitamente', async () => {
    responderBusqueda({ matches: [], nextCursor: null });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'zzz{Enter}');

    expect(await p.findByText('No encontramos partidos para «zzz».')).toBeInTheDocument();
    expect(p.queryByRole('list')).not.toBeInTheDocument();
  });

  it('una nueva búsqueda reemplaza los resultados anteriores', async () => {
    const user = userEvent.setup();
    const p = await pantalla();

    responderBusqueda({ matches: [river], nextCursor: null });
    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
    await p.findByRole('heading', { name: 'River Plate vs. Boca Juniors' });

    responderBusqueda({ matches: [racing], nextCursor: null });
    await user.clear(p.getByLabelText('Equipo'));
    await user.type(p.getByLabelText('Equipo'), 'racing{Enter}');

    expect(await p.findByRole('heading', { name: 'Racing Club vs. Independiente' })).toBeVisible();
    expect(
      p.queryByRole('heading', { name: 'River Plate vs. Boca Juniors' }),
    ).not.toBeInTheDocument();
    expect(busquedas()).toHaveLength(2);
  });

  it('descarta la respuesta de una búsqueda vieja si ya hay una más nueva', async () => {
    let resolverPrimera: (response: Response) => void = () => {};
    let llamadas = 0;
    fetchSpy.mockImplementation((input: unknown) => {
      if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));
      llamadas += 1;
      return llamadas === 1
        ? new Promise<Response>((resolve) => {
            resolverPrimera = resolve;
          })
        : Promise.resolve(jsonResponse({ matches: [racing], nextCursor: null }));
    });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
    await user.clear(p.getByLabelText('Equipo'));
    await user.type(p.getByLabelText('Equipo'), 'racing{Enter}');
    await p.findByRole('heading', { name: 'Racing Club vs. Independiente' });

    resolverPrimera(jsonResponse({ matches: [river], nextCursor: null }));

    await waitFor(() => expect(llamadas).toBe(2));
    expect(
      p.queryByRole('heading', { name: 'River Plate vs. Boca Juniors' }),
    ).not.toBeInTheDocument();
  });
});

describe('Búsqueda: errores', () => {
  it('un fallo del servidor muestra un mensaje y permite reintentar la misma búsqueda', async () => {
    responderBusqueda({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

    expect(await p.findByRole('alert')).toHaveTextContent('No pudimos cargar los partidos');

    responderBusqueda({ matches: [river], nextCursor: null });
    await user.click(p.getByRole('button', { name: 'Reintentar' }));

    expect(await p.findByRole('heading', { name: 'River Plate vs. Boca Juniors' })).toBeVisible();
    expect(busquedas()).toHaveLength(2);
    expect(new URL(busquedas()[1]![0]).searchParams.get('q')).toBe('river');
  });

  it('un corte de red se avisa como tal', async () => {
    fetchSpy.mockImplementation((input: unknown) =>
      esBusqueda(input)
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(jsonResponse({ matches: [] })),
    );
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

    expect(await p.findByRole('alert')).toHaveTextContent('No pudimos conectarnos');
  });

  it('con la sesión vencida ofrece volver a ingresar y no reintentar', async () => {
    responderBusqueda({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

    expect(await p.findByRole('alert')).toHaveTextContent('La sesión venció');
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('no muestra el error crudo de la API', async () => {
    responderBusqueda({ error: { code: 'INTERNAL_ERROR', message: 'boom interno' } }, 500);
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
    await p.findByRole('alert');

    expect(p.queryByText(/boom interno/)).not.toBeInTheDocument();
  });
});

describe('Búsqueda: Cargar más', () => {
  /** Responde la primera página y, con `cursor`, la que corresponda. */
  function responderPaginas(paginas: Record<string, unknown>) {
    fetchSpy.mockImplementation((input: unknown) => {
      if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));

      const cursor = new URL(String(input)).searchParams.get('cursor') ?? 'primera';

      return Promise.resolve(jsonResponse(paginas[cursor]));
    });
  }

  async function buscarYEsperar(p: Awaited<ReturnType<typeof pantalla>>, texto = 'local') {
    const user = userEvent.setup();

    await user.type(p.getByLabelText('Equipo'), `${texto}{Enter}`);
    await p.findByRole('list');

    return user;
  }

  it('sin otra página no muestra Cargar más', async () => {
    responderPaginas({ primera: { matches: pagina(1, 3), nextCursor: null } });
    const p = await pantalla();

    await buscarYEsperar(p);

    expect(p.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('pide páginas de 20 y suma la siguiente a los resultados existentes', async () => {
    responderPaginas({
      primera: { matches: pagina(1, 20), nextCursor: 'c1' },
      c1: { matches: pagina(21, 5), nextCursor: null },
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    expect(p.getByText('20 partidos para «local».')).toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'Cargar más' }));

    expect(await p.findByText('25 partidos para «local».')).toBeInTheDocument();
    expect(p.getAllByRole('listitem')).toHaveLength(25);
    expect(p.getByRole('heading', { name: 'Local 1 vs. Visitante 1' })).toBeInTheDocument();
    expect(p.getByRole('heading', { name: 'Local 25 vs. Visitante 25' })).toBeInTheDocument();

    const [primera, segunda] = busquedas().map(([url]) => new URL(url).searchParams);
    expect(primera!.get('limit')).toBe('20');
    expect(primera!.has('cursor')).toBe(false);
    expect(segunda!.get('limit')).toBe('20');
    expect(segunda!.get('cursor')).toBe('c1');
    expect(segunda!.get('q')).toBe('local');
  });

  it('con la última página el botón desaparece y el foco pasa al resumen', async () => {
    responderPaginas({
      primera: { matches: pagina(1, 20), nextCursor: 'c1' },
      c1: { matches: pagina(21, 1), nextCursor: null },
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    await user.click(p.getByRole('button', { name: 'Cargar más' }));

    await waitFor(() => expect(p.queryByRole('button', { name: 'Cargar más' })).toBeNull());
    expect(p.getByText('21 partidos para «local».')).toHaveFocus();
  });

  it('mientras carga la página siguiente no admite un segundo pedido', async () => {
    let resolver: (response: Response) => void = () => {};
    fetchSpy.mockImplementation((input: unknown) => {
      if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));
      if (!new URL(String(input)).searchParams.has('cursor')) {
        return Promise.resolve(jsonResponse({ matches: pagina(1, 20), nextCursor: 'c1' }));
      }
      return new Promise<Response>((resolve) => {
        resolver = resolve;
      });
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    await user.click(p.getByRole('button', { name: 'Cargar más' }));
    const cargando = await p.findByRole('button', { name: 'Cargando…' });
    await user.click(cargando);
    await user.click(cargando);

    expect(cargando).toHaveAttribute('aria-busy', 'true');
    expect(busquedas()).toHaveLength(2);

    resolver(jsonResponse({ matches: pagina(21, 1), nextCursor: null }));
    expect(await p.findByText('21 partidos para «local».')).toBeInTheDocument();
  });

  it('si falla la página siguiente conserva los resultados y permite reintentar', async () => {
    const paginas: Record<string, unknown> = {
      primera: { matches: pagina(1, 20), nextCursor: 'c1' },
    };
    responderPaginas(paginas);
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esBusqueda(input)
          ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
          : jsonResponse({ matches: [] }),
      ),
    );
    await user.click(p.getByRole('button', { name: 'Cargar más' }));

    expect(await p.findByRole('alert')).toHaveTextContent('No pudimos cargar los partidos');
    expect(p.getAllByRole('listitem')).toHaveLength(20);
    expect(p.getByText('20 partidos para «local».')).toBeInTheDocument();

    paginas.c1 = { matches: pagina(21, 2), nextCursor: null };
    responderPaginas(paginas);
    await user.click(p.getByRole('button', { name: 'Reintentar' }));

    expect(await p.findByText('22 partidos para «local».')).toBeInTheDocument();
    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(new URL(busquedas().at(-1)![0]).searchParams.get('cursor')).toBe('c1');
  });

  it('con la sesión vencida al paginar conserva los resultados y ofrece volver a ingresar', async () => {
    responderPaginas({ primera: { matches: pagina(1, 20), nextCursor: 'c1' } });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esBusqueda(input)
          ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)
          : jsonResponse({ matches: [] }),
      ),
    );
    await user.click(p.getByRole('button', { name: 'Cargar más' }));

    expect(await p.findByRole('alert')).toHaveTextContent('La sesión venció');
    expect(p.getAllByRole('listitem')).toHaveLength(20);
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'Iniciar sesión nuevamente' }));
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('no repite partidos que la página siguiente devuelve otra vez', async () => {
    responderPaginas({
      primera: { matches: pagina(1, 20), nextCursor: 'c1' },
      c1: { matches: [...pagina(19, 4)], nextCursor: null },
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    await user.click(p.getByRole('button', { name: 'Cargar más' }));

    expect(await p.findByText('22 partidos para «local».')).toBeInTheDocument();
    expect(p.getAllByRole('heading', { name: 'Local 19 vs. Visitante 19' })).toHaveLength(1);
    expect(p.getAllByRole('heading', { name: 'Local 20 vs. Visitante 20' })).toHaveLength(1);
  });

  it('una búsqueda nueva reinicia la paginación: sin cursor y sin resultados viejos', async () => {
    responderPaginas({
      primera: { matches: pagina(1, 20), nextCursor: 'c1' },
      c1: { matches: pagina(21, 5), nextCursor: null },
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);
    await user.click(p.getByRole('button', { name: 'Cargar más' }));
    await p.findByText('25 partidos para «local».');

    responderPaginas({ primera: { matches: [racing], nextCursor: null } });
    await user.clear(p.getByLabelText('Equipo'));
    await user.type(p.getByLabelText('Equipo'), 'racing{Enter}');

    expect(await p.findByText('1 partido para «racing».')).toBeInTheDocument();
    expect(p.getAllByRole('listitem')).toHaveLength(1);
    expect(p.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
    expect(new URL(busquedas().at(-1)![0]).searchParams.has('cursor')).toBe(false);
  });

  it('descarta la página siguiente que llega después de una búsqueda nueva', async () => {
    let resolverVieja: (response: Response) => void = () => {};
    fetchSpy.mockImplementation((input: unknown) => {
      if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));

      const params = new URL(String(input)).searchParams;

      if (params.get('cursor') === 'c1') {
        return new Promise<Response>((resolve) => {
          resolverVieja = resolve;
        });
      }

      return Promise.resolve(
        jsonResponse(
          params.get('q') === 'local'
            ? { matches: pagina(1, 20), nextCursor: 'c1' }
            : { matches: [racing], nextCursor: null },
        ),
      );
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    await user.click(p.getByRole('button', { name: 'Cargar más' }));
    await p.findByRole('button', { name: 'Cargando…' });

    await user.clear(p.getByLabelText('Equipo'));
    await user.type(p.getByLabelText('Equipo'), 'racing{Enter}');
    await p.findByText('1 partido para «racing».');

    resolverVieja(jsonResponse({ matches: pagina(21, 5), nextCursor: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(p.getByText('1 partido para «racing».')).toBeInTheDocument();
    expect(p.getAllByRole('listitem')).toHaveLength(1);
  });

  it('descarta una página siguiente fallida de una búsqueda anterior', async () => {
    let rechazarVieja: (error: unknown) => void = () => {};
    fetchSpy.mockImplementation((input: unknown) => {
      if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));

      const params = new URL(String(input)).searchParams;

      if (params.get('cursor') === 'c1') {
        return new Promise<Response>((_resolve, reject) => {
          rechazarVieja = reject;
        });
      }

      return Promise.resolve(
        jsonResponse(
          params.get('q') === 'local'
            ? { matches: pagina(1, 20), nextCursor: 'c1' }
            : { matches: [racing], nextCursor: null },
        ),
      );
    });
    const p = await pantalla();
    const user = await buscarYEsperar(p);

    await user.click(p.getByRole('button', { name: 'Cargar más' }));
    await p.findByRole('button', { name: 'Cargando…' });
    await user.clear(p.getByLabelText('Equipo'));
    await user.type(p.getByLabelText('Equipo'), 'racing{Enter}');
    await p.findByText('1 partido para «racing».');

    rechazarVieja(new TypeError('fetch failed'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(p.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('al cambiar de sesión descarta resultados y respuestas pendientes de la anterior', async () => {
    let resolverVieja: (response: Response) => void = () => {};
    fetchSpy.mockImplementation((input: unknown) => {
      if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));
      return new Promise<Response>((resolve) => {
        resolverVieja = resolve;
      });
    });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
    await p.findByText('Buscando…');

    const alCambiarAuth = authMock.onAuthStateChange.mock.calls[0]![0] as (
      event: string,
      session: Session,
    ) => void;
    const otra = {
      access_token: 'token-otra',
      user: { id: 'user-2', email: 'c@d.com' },
    } as Session;
    act(() => alCambiarAuth('SIGNED_IN', otra));

    await waitFor(() => expect(p.getByLabelText('Equipo')).toHaveValue(''));
    expect(p.getByText(/Escribí el nombre de un equipo y apretá Buscar/)).toBeInTheDocument();

    resolverVieja(jsonResponse({ matches: [river], nextCursor: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(p.queryByRole('heading', { name: 'River Plate vs. Boca Juniors' })).toBeNull();
  });

  it('renovar el token de la misma persona no borra sus resultados', async () => {
    responderPaginas({ primera: { matches: pagina(1, 3), nextCursor: null } });
    const p = await pantalla();
    await buscarYEsperar(p);

    const alCambiarAuth = authMock.onAuthStateChange.mock.calls[0]![0] as (
      event: string,
      session: Session,
    ) => void;
    act(() =>
      alCambiarAuth('TOKEN_REFRESHED', { ...session, access_token: 'token-nuevo' } as Session),
    );

    expect(p.getByText('3 partidos para «local».')).toBeInTheDocument();
  });
});
