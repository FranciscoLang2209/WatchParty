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

describe('Búsqueda: formulario', () => {
  it('muestra el campo con su etiqueta y el botón Buscar', async () => {
    const p = await pantalla();

    expect(p.getByRole('search')).toBeInTheDocument();
    expect(p.getByLabelText('Equipo')).toBeInTheDocument();
    expect(p.getByRole('button', { name: 'Buscar' })).toHaveAttribute('type', 'submit');
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
    expect(url).toBe(`${API_BASE}/matches/search?q=river`);
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
  it('lista los partidos con la tarjeta existente y cuenta los resultados', async () => {
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

  it('si hay más páginas avisa en vez de aparentar una lista completa', async () => {
    responderBusqueda({ matches: [river], nextCursor: 'siguiente' });
    const user = userEvent.setup();
    const p = await pantalla();

    await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

    expect(await p.findByText(/Hay más resultados/)).toBeInTheDocument();
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

  describe('401 de un token reemplazado', () => {
    const renovarToken = () => {
      const alCambiarAuth = authMock.onAuthStateChange.mock.calls[0]![0] as (
        event: string,
        session: Session,
      ) => void;

      act(() =>
        alCambiarAuth('TOKEN_REFRESHED', { ...session, access_token: 'token-nuevo' } as Session),
      );
    };

    const tokenDe = (init: RequestInit) => new Headers(init.headers).get('Authorization');

    it('reintenta con el token vigente y no muestra «La sesión venció»', async () => {
      // Con `token-123` la petición queda en espera hasta que se la rechaza con 401.
      const pendientes: Array<() => void> = [];

      fetchSpy.mockImplementation((input: unknown, init?: RequestInit) => {
        if (!esBusqueda(input)) return Promise.resolve(jsonResponse({ matches: [] }));

        if (tokenDe(init ?? {}) === 'Bearer token-123') {
          return new Promise<Response>((resolve) => {
            pendientes.push(() => resolve(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401)));
          });
        }

        return Promise.resolve(jsonResponse({ matches: [river], nextCursor: null }));
      });
      const user = userEvent.setup();
      const p = await pantalla();

      await user.type(p.getByLabelText('Equipo'), 'river{Enter}');
      await p.findByText('Buscando…');
      renovarToken();
      act(() => pendientes.splice(0).forEach((rechazar) => rechazar()));

      expect(
        await p.findByRole('heading', { name: 'River Plate vs. Boca Juniors' }),
      ).toBeInTheDocument();
      expect(p.queryByText(/La sesión venció/)).not.toBeInTheDocument();
      expect(p.queryByRole('button', { name: 'Iniciar sesión nuevamente' })).toBeNull();
      expect(busquedas().map(([, init]) => tokenDe(init))).toEqual([
        'Bearer token-123',
        'Bearer token-nuevo',
      ]);
    });

    it('un 401 con el token que sigue vigente no se reintenta', async () => {
      responderBusqueda({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);
      const user = userEvent.setup();
      const p = await pantalla();

      await user.type(p.getByLabelText('Equipo'), 'river{Enter}');

      expect(await p.findByRole('alert')).toHaveTextContent('La sesión venció');
      expect(busquedas()).toHaveLength(1);
    });
  });
});
