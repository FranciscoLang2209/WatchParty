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

    const m = await directorio();
    const items = await m.findAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(m.getAllByRole('list')).toHaveLength(2);
    expect(m.getByText(/River Plate/)).toBeInTheDocument();
    expect(m.getByText(/Racing Club/)).toBeInTheDocument();
    expect(m.getByText('Programado')).toBeInTheDocument();
    expect(m.getByText('En vivo', { selector: 'span' })).toBeInTheDocument();
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

    // Racing está en vivo: su sección va primero, aunque la API lo traiga segundo.
    const primerEnlace = await screen.findByRole('link', {
      name: 'Ver partido: Racing Club vs. Independiente',
    });
    const segundoEnlace = screen.getByRole('link', {
      name: 'Ver partido: River Plate vs. Boca Juniors',
    });

    primerEnlace.focus();
    expect(primerEnlace).toHaveFocus();

    await user.tab();
    expect(segundoEnlace).toHaveFocus();
  });

  it('no muestra partidos finalizados, pospuestos ni cancelados', async () => {
    conSesion();
    const finished = { ...river, id: 'match-finished', status: 'finished' as const };
    const postponed = { ...river, id: 'match-postponed', status: 'postponed' as const };
    const cancelled = { ...river, id: 'match-cancelled', status: 'cancelled' as const };

    fetchSpy.mockResolvedValue(
      jsonResponse({ matches: [river, racing, finished, postponed, cancelled] }),
    );

    renderAt('/rooms');

    const m = await directorio();
    const items = await m.findAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(m.getByText(/River Plate/)).toBeInTheDocument();
    expect(m.getByText(/Racing Club/)).toBeInTheDocument();
  });

  it('si sólo hay partidos fuera de vista, explica la lista vacía en vez de una grilla vacía', async () => {
    conSesion();
    const finished = { ...river, id: 'match-finished', status: 'finished' as const };

    fetchSpy.mockResolvedValue(jsonResponse({ matches: [finished] }));

    renderAt('/rooms');

    const m = await directorio();
    expect(await m.findByText(/Todavía no hay partidos ni salas disponibles/)).toBeInTheDocument();
    expect(m.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('Directorio de salas — En vivo y Próximos', () => {
  const partido = (id: string, status: 'live' | 'scheduled', homeTeam: string) => ({
    ...river,
    id,
    homeTeam,
    homeTeamId: `team-${id}`,
    status,
  });

  const vivoA = partido('vivo-a', 'live', 'Vivo A');
  const vivoB = partido('vivo-b', 'live', 'Vivo B');
  const proximoA = partido('proximo-a', 'scheduled', 'Proximo A');
  const proximoB = partido('proximo-b', 'scheduled', 'Proximo B');

  function titulosEn(seccion: HTMLElement): (string | null)[] {
    return within(seccion)
      .getAllByRole('heading', { level: 3 })
      .map((titulo) => titulo.textContent);
  }

  it('separa los partidos en las secciones En vivo y Próximos según su estado', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');

    const m = await directorio();
    const enVivo = await m.findByRole('region', { name: 'En vivo' });
    const proximos = m.getByRole('region', { name: 'Próximos' });

    expect(within(enVivo).getByText(/Racing Club/)).toBeInTheDocument();
    expect(within(enVivo).queryByText(/River Plate/)).not.toBeInTheDocument();
    expect(within(proximos).getByText(/River Plate/)).toBeInTheDocument();
    expect(within(proximos).queryByText(/Racing Club/)).not.toBeInTheDocument();
  });

  it('En vivo va primero aunque la API traiga los programados antes', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [proximoA, vivoA] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByRole('region', { name: 'En vivo' });

    expect(m.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'En vivo',
      'Próximos',
    ]);
  });

  it('conserva dentro de cada sección el orden en que llegaron de la API', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [proximoB, vivoB, proximoA, vivoA] }));

    renderAt('/rooms');

    const m = await directorio();
    const enVivo = await m.findByRole('region', { name: 'En vivo' });
    const proximos = m.getByRole('region', { name: 'Próximos' });

    expect(titulosEn(enVivo)).toEqual([
      expect.stringContaining('Vivo B'),
      expect.stringContaining('Vivo A'),
    ]);
    expect(titulosEn(proximos)).toEqual([
      expect.stringContaining('Proximo B'),
      expect.stringContaining('Proximo A'),
    ]);
  });

  it('no duplica partidos: cada uno aparece una sola vez en todo el directorio', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [vivoA, proximoA, vivoB, proximoB] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByRole('region', { name: 'En vivo' });

    expect(m.getAllByRole('listitem')).toHaveLength(4);
    expect(m.getAllByRole('link', { name: /Ver partido/ })).toHaveLength(4);
    expect(m.getAllByRole('link', { name: 'Ver partido: Vivo A vs. Boca Juniors' })).toHaveLength(
      1,
    );
  });

  it('sin partidos en vivo no muestra la sección En vivo', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [proximoA] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByRole('region', { name: 'Próximos' });

    expect(m.queryByRole('region', { name: 'En vivo' })).not.toBeInTheDocument();
    expect(m.queryByRole('heading', { name: 'En vivo' })).not.toBeInTheDocument();
    expect(m.getAllByRole('list')).toHaveLength(1);
  });

  it('sin próximos no muestra la sección Próximos', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [vivoA] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByRole('region', { name: 'En vivo' });

    expect(m.queryByRole('region', { name: 'Próximos' })).not.toBeInTheDocument();
    expect(m.queryByRole('heading', { name: 'Próximos' })).not.toBeInTheDocument();
    expect(m.getAllByRole('list')).toHaveLength(1);
  });

  it('los partidos fuera de vista no abren ninguna sección', async () => {
    conSesion();
    const finished = { ...river, id: 'match-finished', status: 'finished' as const };

    fetchSpy.mockResolvedValue(jsonResponse({ matches: [finished, vivoA] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByRole('region', { name: 'En vivo' });

    expect(m.queryByRole('region', { name: 'Próximos' })).not.toBeInTheDocument();
    expect(m.getAllByRole('listitem')).toHaveLength(1);
  });

  it('cada título de sección es un h2 y los partidos cuelgan como h3', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [vivoA, proximoA] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByRole('region', { name: 'En vivo' });

    expect(m.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(m.getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(m.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });

  it('el foco pasa de En vivo a Próximos en el orden en que se leen', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [proximoA, vivoA] }));

    renderAt('/rooms');

    const m = await directorio();
    const enlaceVivo = await m.findByRole('link', {
      name: 'Ver partido: Vivo A vs. Boca Juniors',
    });
    const enlaceProximo = m.getByRole('link', {
      name: 'Ver partido: Proximo A vs. Boca Juniors',
    });

    enlaceVivo.focus();
    await user.tab();

    expect(enlaceProximo).toHaveFocus();
  });

  it('sigue siendo una sola petición al mismo catálogo, sin endpoint de búsqueda', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [vivoA, proximoA] }));

    renderAt('/rooms');
    await (await directorio()).findByRole('region', { name: 'En vivo' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ultimaPeticion()[0]).toBe(`${API_BASE}/matches`);
  });
});

describe('Directorio de salas — encabezado y grilla', () => {
  const DESCRIPCION = 'Elegí un partido en vivo o próximo para entrar a su sala.';

  it('presenta el título como único h1 y una descripción breve debajo', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));

    renderAt('/rooms');

    const m = await directorio();
    const titulo = await m.findByRole('heading', { level: 1, name: 'Salas' });
    const descripcion = m.getByText(DESCRIPCION);

    expect(m.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(titulo.parentElement).toContainElement(descripcion);
    expect(titulo.compareDocumentPosition(descripcion)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('la descripción acompaña al título mientras carga, ante un error y con la lista vacía', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    const cargando = renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('status');
    expect(m.getByText(DESCRIPCION)).toBeInTheDocument();
    cargando.unmount();

    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const conError = renderAt('/rooms');
    const e = await directorio();
    await e.findByRole('alert');
    expect(e.getByText(DESCRIPCION)).toBeInTheDocument();
    conError.unmount();

    fetchSpy.mockResolvedValue(jsonResponse({ matches: [] }));
    renderAt('/rooms');
    const v = await directorio();
    await v.findByText(/Todavía no hay partidos ni salas disponibles/);
    expect(v.getByText(DESCRIPCION)).toBeInTheDocument();
  });

  it('la grilla pasa de 1 a 2 y a 3 columnas según el ancho disponible', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');

    const listas = await screen.findAllByRole('list');

    expect(listas).toHaveLength(2);

    for (const lista of listas) {
      expect(lista).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3');
    }
  });

  it('la página no usa anchos fijos en píxeles ni valores arbitrarios', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findAllByRole('list');
    const clases = Array.from(screen.getByRole('main').querySelectorAll('[class]'))
      .map((elemento) => elemento.getAttribute('class') ?? '')
      .join(' ');

    expect(clases).not.toMatch(/(?:^|\s)(?:\w+:)?(?:min-|max-)?[wh]-\[/);
    expect(clases).not.toMatch(/\[\d+(?:\.\d+)?px\]/);
  });
});
