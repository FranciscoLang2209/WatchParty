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

describe('Directorio de salas — presentación de las tarjetas', () => {
  it('las tarjetas usan la variante del directorio: el enlace es una acción de 44 px', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');

    const enlaces = await screen.findAllByRole('link', { name: /Ver partido/ });

    expect(enlaces).toHaveLength(2);

    for (const enlace of enlaces) {
      expect(enlace).toHaveClass('h-11', 'w-full');
    }
  });

  it('no agrega botones a las tarjetas: su única acción es su enlace', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river, racing] }));

    renderAt('/rooms');
    const m = await directorio();
    await m.findAllByRole('link', { name: /Ver partido/ });

    for (const lista of m.getAllByRole('list')) {
      expect(within(lista).queryByRole('button')).not.toBeInTheDocument();
    }

    // Fuera de las tarjetas sólo quedan el filtro Todos / Mi equipo y Actualizar.
    expect(m.getAllByRole('button').map((boton) => boton.textContent)).toEqual([
      'Todos',
      'Mi equipo',
      'Actualizar',
    ]);
  });
});

describe('Directorio de salas — carga, vacío y error', () => {
  const respuesta401 = () =>
    jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401);

  it('la carga se presenta como un panel con título y mensaje, y marca la pantalla como ocupada', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    renderAt('/rooms');

    const m = await directorio();
    const estado = await m.findByRole('status');

    expect(
      within(estado).getByRole('heading', { level: 2, name: 'Un momento' }),
    ).toBeInTheDocument();
    expect(estado).toHaveTextContent('Cargando el directorio…');
    expect(estado.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('main').querySelector('section')).toHaveAttribute('aria-busy', 'true');
  });

  it('al terminar de cargar la pantalla deja de estar ocupada', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [river] }));

    renderAt('/rooms');

    const m = await directorio();
    await m.findByText(/River Plate/);

    expect(screen.getByRole('main').querySelector('section')).toHaveAttribute('aria-busy', 'false');
    expect(m.queryByRole('status')).not.toBeInTheDocument();
  });

  it('la lista vacía es un panel informativo: sin alerta, sin estado y sin acciones propias', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [] }));

    renderAt('/rooms');

    const m = await directorio();

    expect(
      await m.findByRole('heading', { level: 2, name: 'No hay partidos por ahora' }),
    ).toBeInTheDocument();
    expect(m.getByText(/Todavía no hay partidos ni salas disponibles/)).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(m.queryByRole('status')).not.toBeInTheDocument();
    // El panel no agrega acciones: la única es Actualizar, que vive fuera de él.
    expect(m.getAllByRole('button').map((boton) => boton.textContent)).toEqual(['Actualizar']);
  });

  it('un fallo recuperable se anuncia como alerta, con título, mensaje y Reintentar', async () => {
    conSesion();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderAt('/rooms');

    const m = await directorio();
    const alerta = await m.findByRole('alert');

    expect(
      within(alerta).getByRole('heading', { level: 2, name: 'Algo salió mal' }),
    ).toBeInTheDocument();
    expect(alerta).toHaveTextContent('No pudimos conectarnos.');
    expect(within(alerta).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(
      within(alerta).queryByRole('button', { name: /Iniciar sesión/ }),
    ).not.toBeInTheDocument();
    expect(alerta.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('la sesión vencida se distingue del error recuperable: otro título, otra acción y sin Reintentar', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(respuesta401());

    renderAt('/rooms');

    const m = await directorio();
    const alerta = await m.findByRole('alert');

    expect(
      within(alerta).getByRole('heading', { level: 2, name: 'Necesitás ingresar de nuevo' }),
    ).toBeInTheDocument();
    expect(
      within(alerta).queryByRole('heading', { name: 'Algo salió mal' }),
    ).not.toBeInTheDocument();
    expect(alerta).toHaveTextContent('La sesión venció. Iniciá sesión nuevamente.');
    expect(
      within(alerta).getByRole('button', { name: 'Iniciar sesión nuevamente' }),
    ).toBeInTheDocument();
    expect(m.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('los tres estados comparten la misma estructura: icono decorativo, título y mensaje', async () => {
    conSesion();

    async function estructura(responder: () => Promise<Response>) {
      fetchSpy.mockImplementation(responder);
      const vista = renderAt('/rooms');
      const m = await directorio();
      const titulo = await m.findByRole('heading', { level: 2 });
      const tarjeta = titulo.parentElement as HTMLElement;
      const forma = {
        icono: tarjeta.querySelector('svg')?.getAttribute('aria-hidden'),
        titulo: tarjeta.querySelector('h2') !== null,
        mensaje: tarjeta.querySelector('p') !== null,
        clases: tarjeta.className,
      };

      vista.unmount();

      return forma;
    }

    const vacio = await estructura(async () => jsonResponse({ matches: [] }));
    const fallo = await estructura(() => Promise.reject(new TypeError('Failed to fetch')));
    const vencida = await estructura(async () => respuesta401());

    expect(vacio).toEqual({ icono: 'true', titulo: true, mensaje: true, clases: vacio.clases });
    expect(fallo).toEqual(vacio);
    expect(vencida).toEqual(vacio);
  });

  it('al reintentar el foco pasa al panel de carga y, si sale bien, se muestran los partidos', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('alert');

    let resolver: (respuesta: Response) => void = () => {};
    fetchSpy.mockReturnValue(new Promise<Response>((resolve) => (resolver = resolve)));
    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    const cargando = await m.findByRole('status');
    await waitFor(() => expect(cargando).toHaveFocus());
    expect(m.queryByRole('alert')).not.toBeInTheDocument();

    resolver(jsonResponse({ matches: [river] }));
    expect(await m.findByText(/River Plate/)).toBeInTheDocument();
    expect(m.queryByRole('status')).not.toBeInTheDocument();
  });

  it('si el reintento vuelve a fallar muestra otra vez el error con su Reintentar', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('alert');

    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    expect(await m.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('no pierde los controles de sesión existentes cuando falla la carga', async () => {
    conSesion();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderAt('/rooms');
    await (await directorio()).findByRole('alert');

    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('el icono de carga no gira con movimiento reducido', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    renderAt('/rooms');

    const estado = await (await directorio()).findByRole('status');

    expect(estado.querySelector('svg')).toHaveClass('animate-spin', 'motion-reduce:animate-none');
  });
});

describe('Directorio de salas — foco al terminar el reintento', () => {
  const vivo = { ...racing, id: 'match-vivo', homeTeam: 'Vivo A', homeTeamId: 'team-vivo-a' };
  const proximo = {
    ...river,
    id: 'match-proximo',
    homeTeam: 'Proximo A',
    homeTeamId: 'team-proximo-a',
  };

  /** Deja el directorio en error recuperable y devuelve cómo contestar al reintento. */
  async function reintentarConRespuestaPendiente() {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('alert');

    let responder: (respuesta: Response | Error) => void = () => {};
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve, reject) => {
        responder = (respuesta) =>
          respuesta instanceof Error ? reject(respuesta) : resolve(respuesta);
      }),
    );
    await user.click(m.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(m.getByRole('status')).toHaveFocus());

    return { m, user, responder };
  }

  it('si el reintento trae partidos, el foco pasa a la primera sección y no vuelve al body', async () => {
    const { m, responder } = await reintentarConRespuestaPendiente();

    responder(jsonResponse({ matches: [proximo, vivo] }));

    const titulo = await m.findByRole('heading', { level: 2, name: 'En vivo' });

    await waitFor(() => expect(titulo).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('desde ese foco, Tab sigue por los enlaces de la primera sección', async () => {
    const { m, user, responder } = await reintentarConRespuestaPendiente();

    responder(jsonResponse({ matches: [vivo, proximo] }));

    const titulo = await m.findByRole('heading', { level: 2, name: 'En vivo' });
    await waitFor(() => expect(titulo).toHaveFocus());
    await user.tab();

    expect(m.getByRole('link', { name: 'Ver partido: Vivo A vs. Independiente' })).toHaveFocus();
  });

  it('si el reintento trae la lista vacía, el foco pasa al panel de lista vacía', async () => {
    const { m, responder } = await reintentarConRespuestaPendiente();

    responder(jsonResponse({ matches: [] }));

    const titulo = await m.findByRole('heading', { level: 2, name: 'No hay partidos por ahora' });

    await waitFor(() => expect(titulo.parentElement?.parentElement).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('si el reintento vuelve a fallar, el foco pasa a la nueva alerta con su Reintentar', async () => {
    const { m, responder } = await reintentarConRespuestaPendiente();

    responder(new TypeError('Failed to fetch'));

    const alerta = await m.findByRole('alert');

    await waitFor(() => expect(alerta).toHaveFocus());
    expect(within(alerta).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('si el reintento termina en sesión vencida, el foco pasa a la alerta de reingreso', async () => {
    const { m, responder } = await reintentarConRespuestaPendiente();

    responder(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401));

    const alerta = await m.findByRole('alert');

    await waitFor(() => expect(alerta).toHaveFocus());
    expect(
      within(alerta).getByRole('button', { name: 'Iniciar sesión nuevamente' }),
    ).toBeInTheDocument();
  });

  it('cada reintento sucesivo vuelve a llevar el foco al resultado', async () => {
    const user = userEvent.setup();
    conSesion();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('alert');

    for (let vuelta = 0; vuelta < 2; vuelta += 1) {
      await user.click(m.getByRole('button', { name: 'Reintentar' }));
      const alerta = await m.findByRole('alert');

      await waitFor(() => expect(alerta).toHaveFocus());
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('la carga inicial no roba el foco: sólo un reintento lo mueve', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [vivo] }));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('heading', { level: 2, name: 'En vivo' });

    expect(document.activeElement).toBe(document.body);
  });
});

describe('Directorio de salas — filtro Mi equipo', () => {
  const PERFIL_URL = `${API_BASE}/me/profile`;

  const otraSesion = {
    access_token: 'token-otro',
    user: { id: 'user-2', email: 'otra@b.com' },
  } as Session;

  const partido = (
    id: string,
    status: 'live' | 'scheduled',
    local: [string, string],
    visitante: [string, string],
  ) => ({
    ...river,
    id,
    status,
    homeTeam: local[0],
    homeTeamId: local[1],
    awayTeam: visitante[0],
    awayTeamId: visitante[1],
  });

  // Boca juega de visitante en `river` (programado) y de local en `bocaLocal` (en vivo).
  const bocaLocal = partido(
    'm-boca-local',
    'live',
    ['Boca Juniors', 'team-boca-juniors'],
    ['Lanús', 'team-lanus'],
  );
  // Mismo nombre que Boca pero otro id: el favorito se compara por id, nunca por nombre.
  const homonimo = partido(
    'm-homonimo',
    'scheduled',
    ['Boca Juniors', 'team-otro-boca'],
    ['Tigre', 'team-tigre'],
  );
  const agenda = [river, racing, bocaLocal, homonimo];

  const perfilCon = (favoriteTeamId: string | null) => () =>
    Promise.resolve(jsonResponse({ profile: { displayName: 'Martu', bio: '', favoriteTeamId } }));

  /** `/matches` responde la agenda y `/me/profile` lo que decida cada prueba, según el bearer. */
  function servidor(perfil: (bearer: string) => Promise<Response>, partidos: unknown[] = agenda) {
    fetchSpy.mockImplementation((input: unknown, init?: RequestInit) =>
      String(input) === PERFIL_URL
        ? perfil(new Headers(init?.headers).get('Authorization') ?? '')
        : Promise.resolve(jsonResponse({ matches: partidos })),
    );
  }

  function llamadasAlPerfil() {
    return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
      ([url]) => String(url) === PERFIL_URL,
    );
  }

  async function abrir() {
    conSesion();
    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('group', { name: 'Filtrar partidos' });

    return m;
  }

  function enlacesDe(m: ReturnType<typeof within>) {
    return m
      .queryAllByRole('link', { name: /Ver partido/ })
      .map((enlace: HTMLElement) => enlace.getAttribute('aria-label'));
  }

  it('ofrece Todos y Mi equipo, con Todos elegido y sin pedir el perfil todavía', async () => {
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();

    expect(m.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
    expect(m.getByRole('button', { name: 'Mi equipo' })).toHaveAttribute('aria-pressed', 'false');
    expect(enlacesDe(m)).toHaveLength(4);
    expect(llamadasAlPerfil()).toHaveLength(0);
  });

  it('al elegir Mi equipo pide el perfil con el bearer y deja los partidos del favorito', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));
    expect(m.getByRole('button', { name: 'Mi equipo' })).toHaveAttribute('aria-pressed', 'true');
    expect(m.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'false');

    const [pedido] = llamadasAlPerfil();

    expect(llamadasAlPerfil()).toHaveLength(1);
    expect(new Headers(pedido![1].headers).get('Authorization')).toBe(
      `Bearer ${session.access_token}`,
    );
  });

  it('incluye al favorito como local y como visitante, y compara por id y no por nombre', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));

    expect(enlacesDe(m)).toEqual(
      expect.arrayContaining([
        'Ver partido: Boca Juniors vs. Lanús',
        'Ver partido: River Plate vs. Boca Juniors',
      ]),
    );
    expect(enlacesDe(m)).not.toContain('Ver partido: Boca Juniors vs. Tigre');
  });

  it('conserva las secciones En vivo y Próximos dentro del filtro', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    const enVivo = await m.findByRole('region', { name: 'En vivo' });
    const proximos = m.getByRole('region', { name: 'Próximos' });

    expect(within(enVivo).getByText(/Lanús/)).toBeInTheDocument();
    expect(within(proximos).getByText(/River Plate/)).toBeInTheDocument();
    expect(within(proximos).queryByText(/Tigre/)).not.toBeInTheDocument();
  });

  it('no muestra una sección sin partidos del favorito', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-lanus'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    await m.findByRole('region', { name: 'En vivo' });

    expect(m.queryByRole('region', { name: 'Próximos' })).not.toBeInTheDocument();
    expect(enlacesDe(m)).toEqual(['Ver partido: Boca Juniors vs. Lanús']);
  });

  it('Todos restaura el listado completo sin volver a pedir el perfil', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));

    await user.click(m.getByRole('button', { name: 'Todos' }));
    expect(enlacesDe(m)).toHaveLength(4);

    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));

    expect(llamadasAlPerfil()).toHaveLength(1);
    expect(m.getByRole('region', { name: 'En vivo' })).toBeInTheDocument();
    expect(m.getByRole('region', { name: 'Próximos' })).toBeInTheDocument();
  });

  it('se puede elegir con el teclado: Enter y Espacio', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    const miEquipo = m.getByRole('button', { name: 'Mi equipo' });

    miEquipo.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));
    expect(miEquipo).toHaveFocus();

    const todos = m.getByRole('button', { name: 'Todos' });

    todos.focus();
    await user.keyboard(' ');

    expect(enlacesDe(m)).toHaveLength(4);
    expect(todos).toHaveAttribute('aria-pressed', 'true');
  });

  it('sin favorito explica cómo elegirlo y enlaza al perfil, sin mostrar partidos', async () => {
    const user = userEvent.setup();
    servidor(perfilCon(null));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    const aviso = await m.findByRole('status');

    expect(within(aviso).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Todavía no elegiste un equipo',
    );
    expect(aviso).toHaveTextContent('Elegí tu equipo favorito en tu perfil');
    expect(within(aviso).getByRole('link', { name: 'Elegir equipo favorito' })).toHaveAttribute(
      'href',
      '/profile',
    );
    expect(enlacesDe(m)).toEqual([]);
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('un perfil todavía sin completar también es «sin favorito», no un fallo', async () => {
    const user = userEvent.setup();
    servidor(() => Promise.resolve(jsonResponse({ profile: null })));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    expect(await m.findByText(/Todavía no elegiste un equipo/)).toBeInTheDocument();
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sin coincidencias lo dice sin prometer más agenda y permite volver a Todos', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-sin-partidos'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    const aviso = await m.findByRole('status');

    expect(aviso).toHaveTextContent(
      'No hay partidos de tu equipo favorito en la agenda disponible.',
    );
    expect(aviso.textContent).not.toMatch(/próxim|temporada|semana|pronto/i);
    expect(enlacesDe(m)).toEqual([]);
    expect(m.queryByText(/Todavía no elegiste un equipo/)).not.toBeInTheDocument();

    await user.click(within(aviso).getByRole('button', { name: 'Ver todos los partidos' }));

    expect(enlacesDe(m)).toHaveLength(4);
    expect(m.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
    expect(m.getByRole('button', { name: 'Todos' })).toHaveFocus();
  });

  it('si falla el perfil conserva el listado general y avisa, sin decir que no hay favorito', async () => {
    const user = userEvent.setup();
    servidor(() => Promise.reject(new TypeError('Failed to fetch')));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    const alerta = await m.findByRole('alert');

    expect(within(alerta).getByRole('heading', { level: 2 })).toHaveTextContent(
      'No pudimos cargar tu equipo',
    );
    expect(within(alerta).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(m.queryByText(/Todavía no elegiste un equipo/)).not.toBeInTheDocument();
    expect(m.queryByText(/No hay partidos de tu equipo/)).not.toBeInTheDocument();
    expect(enlacesDe(m)).toHaveLength(4);
  });

  it('un 500 del perfil se trata igual que una caída de red', async () => {
    const user = userEvent.setup();
    servidor(() =>
      Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Error.' } }, 500)),
    );

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));

    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos cargar tu equipo');
    expect(enlacesDe(m)).toHaveLength(4);
  });

  it('Reintentar vuelve a pedir sólo el perfil y, si sale bien, filtra y lleva el foco al resultado', async () => {
    const user = userEvent.setup();
    let intento = 0;
    servidor(() =>
      (intento += 1) === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : perfilCon('team-boca-juniors')(),
    );

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await m.findByRole('alert');
    const pedidosAPartidos = () =>
      (fetchSpy.mock.calls as [string, RequestInit][]).filter(([url]) =>
        String(url).endsWith('/matches'),
      ).length;
    const antes = pedidosAPartidos();

    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));
    await waitFor(() =>
      expect(m.getByRole('heading', { level: 2, name: 'En vivo' })).toHaveFocus(),
    );
    expect(llamadasAlPerfil()).toHaveLength(2);
    expect(pedidosAPartidos()).toBe(antes);
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('si el reintento del perfil vuelve a fallar, el foco pasa a la nueva alerta', async () => {
    const user = userEvent.setup();
    servidor(() => Promise.reject(new TypeError('Failed to fetch')));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await m.findByRole('alert');

    await user.click(m.getByRole('button', { name: 'Reintentar' }));

    await waitFor(() => expect(m.getByRole('alert')).toHaveFocus());
    expect(enlacesDe(m)).toHaveLength(4);
  });

  it('descarta la respuesta del perfil de otra sesión y usa el de la sesión vigente', async () => {
    const user = userEvent.setup();
    let responderDeLaPrimera: (respuesta: Response) => void = () => {};
    servidor((bearer) =>
      bearer === `Bearer ${session.access_token}`
        ? new Promise<Response>((resolve) => (responderDeLaPrimera = resolve))
        : perfilCon('team-racing-club')(),
    );

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await m.findByRole('status');

    const [[alCambiarSesion]] = authMock.onAuthStateChange.mock.calls as [
      [(evento: string, sesion: Session | null) => void],
    ];
    act(() => alCambiarSesion('SIGNED_IN', otraSesion));

    await waitFor(() =>
      expect(enlacesDe(m)).toEqual(['Ver partido: Racing Club vs. Independiente']),
    );

    // La primera sesión contesta tarde, con otro favorito: no se aplica.
    await act(async () => {
      responderDeLaPrimera(
        jsonResponse({
          profile: { displayName: 'Otro', bio: '', favoriteTeamId: 'team-boca-juniors' },
        }),
      );
    });

    expect(enlacesDe(m)).toEqual(['Ver partido: Racing Club vs. Independiente']);
    expect(
      llamadasAlPerfil().map(([, init]) => new Headers(init.headers).get('Authorization')),
    ).toEqual([`Bearer ${session.access_token}`, 'Bearer token-otro']);
  });

  it('al cambiar de sesión no queda a la vista el favorito de la anterior', async () => {
    const user = userEvent.setup();
    let responderDeLaOtra: (respuesta: Response) => void = () => {};
    servidor((bearer) =>
      bearer === `Bearer ${session.access_token}`
        ? perfilCon('team-boca-juniors')()
        : new Promise<Response>((resolve) => (responderDeLaOtra = resolve)),
    );

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));

    const [[alCambiarSesion]] = authMock.onAuthStateChange.mock.calls as [
      [(evento: string, sesion: Session | null) => void],
    ];
    act(() => alCambiarSesion('SIGNED_IN', otraSesion));

    expect(await m.findByText('Buscando las salas de tu equipo…')).toBeInTheDocument();
    expect(enlacesDe(m)).toEqual([]);

    await act(async () => {
      responderDeLaOtra(
        jsonResponse({ profile: { displayName: 'Otra', bio: '', favoriteTeamId: 'team-tigre' } }),
      );
    });

    expect(enlacesDe(m)).toEqual(['Ver partido: Boca Juniors vs. Tigre']);
  });

  it('un cambio de token de la misma persona no pierde el favorito ni vuelve a la carga', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));

    const [[alCambiarSesion]] = authMock.onAuthStateChange.mock.calls as [
      [(evento: string, sesion: Session | null) => void],
    ];
    act(() =>
      alCambiarSesion('TOKEN_REFRESHED', {
        ...session,
        access_token: 'token-renovado',
      } as Session),
    );

    expect(m.queryByText('Buscando las salas de tu equipo…')).not.toBeInTheDocument();
    expect(enlacesDe(m)).toHaveLength(2);
  });

  it('sin partidos o con el catálogo caído no hay filtro que ofrecer', async () => {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches: [] }));

    const vacio = renderAt('/rooms');
    const enVacio = await directorio();
    await enVacio.findByText(/Todavía no hay partidos ni salas disponibles/);
    expect(enVacio.queryByRole('group', { name: 'Filtrar partidos' })).not.toBeInTheDocument();
    vacio.unmount();

    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/rooms');
    const enError = await directorio();
    await enError.findByRole('alert');
    expect(enError.queryByRole('group', { name: 'Filtrar partidos' })).not.toBeInTheDocument();
  });

  it('el filtro no consulta Supabase ni agrega pedidos al catálogo', async () => {
    const user = userEvent.setup();
    servidor(perfilCon('team-boca-juniors'));

    const m = await abrir();
    await user.click(m.getByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlacesDe(m)).toHaveLength(2));
    await user.click(m.getByRole('button', { name: 'Todos' }));

    const destinos = (fetchSpy.mock.calls as [string, RequestInit][]).map(([url]) => String(url));

    expect(destinos.filter((url) => url.endsWith('/matches'))).toHaveLength(1);
    expect(destinos.every((url) => url.startsWith(API_BASE))).toBe(true);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('Directorio de salas — actualizar', () => {
  const MATCHES_URL = `${API_BASE}/matches`;

  const otraSesion = {
    access_token: 'token-otro',
    user: { id: 'user-2', email: 'otra@b.com' },
  } as Session;

  const nuevo = {
    ...river,
    id: 'match-nuevo',
    homeTeam: 'Lanús',
    homeTeamId: 'team-lanus',
    awayTeam: 'Tigre',
    awayTeamId: 'team-tigre',
  };

  interface Pedido {
    resolver: (respuesta: Response) => void;
    rechazar: (error: Error) => void;
    signal: AbortSignal | null | undefined;
    bearer: string;
  }

  /**
   * La primera consulta (la carga inicial) responde `inicial` al instante; las
   * siguientes quedan pendientes y cada prueba decide cómo contestarlas.
   */
  function servidor(inicial: unknown[]) {
    const pedidos: Pedido[] = [];
    let primera = true;

    fetchSpy.mockImplementation((_input: unknown, init?: RequestInit) => {
      if (primera) {
        primera = false;

        return Promise.resolve(jsonResponse({ matches: inicial }));
      }

      return new Promise<Response>((resolver, rechazar) => {
        pedidos.push({
          resolver,
          rechazar,
          signal: init?.signal,
          bearer: new Headers(init?.headers).get('Authorization') ?? '',
        });
      });
    });

    return pedidos;
  }

  async function abrir(inicial: unknown[] = [river, racing]) {
    const pedidos = servidor(inicial);

    conSesion();
    const vista = renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('button', { name: 'Actualizar' });

    return { m, pedidos, vista };
  }

  function enlaces(m: ReturnType<typeof within>) {
    return m
      .queryAllByRole('link', { name: /Ver partido/ })
      .map((enlace: HTMLElement) => enlace.getAttribute('aria-label'));
  }

  function alCambiarSesion() {
    const [[callback]] = authMock.onAuthStateChange.mock.calls as [
      [(evento: string, sesion: Session | null) => void],
    ];

    return callback;
  }

  it('ofrece Actualizar con el listado cargado, y no durante la carga ni ante un error', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));

    const cargando = renderAt('/rooms');
    const enCarga = await directorio();
    await enCarga.findByRole('status');
    expect(enCarga.queryByRole('button', { name: /Actualiza/ })).not.toBeInTheDocument();
    cargando.unmount();

    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/rooms');
    const enError = await directorio();
    await enError.findByRole('alert');
    expect(enError.queryByRole('button', { name: /Actualiza/ })).not.toBeInTheDocument();
  });

  it('también se ofrece con la lista vacía, para buscar partidos nuevos', async () => {
    const { m, pedidos } = await abrir([]);

    await userEvent.setup().click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () => pedidos[0]!.resolver(jsonResponse({ matches: [nuevo] })));

    expect(await m.findByText(/Lanús/)).toBeInTheDocument();
    expect(m.queryByText(/Todavía no hay partidos ni salas disponibles/)).not.toBeInTheDocument();
  });

  it('al pulsar muestra Actualizando…, mantiene las tarjetas y consulta el catálogo con el bearer', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));

    const boton = await m.findByRole('button', { name: 'Actualizando…' });

    expect(boton).toHaveAttribute('aria-disabled', 'true');
    expect(boton).toHaveAttribute('aria-busy', 'true');
    expect(enlaces(m)).toHaveLength(2);
    expect(screen.getByRole('main').querySelector('section')).toHaveAttribute('aria-busy', 'true');
    expect(pedidos).toHaveLength(1);
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe(MATCHES_URL);
    expect(pedidos[0]!.bearer).toBe(`Bearer ${session.access_token}`);

    await act(async () => pedidos[0]!.resolver(jsonResponse({ matches: [river, racing] })));

    expect(await m.findByRole('button', { name: 'Actualizar' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('al completar reemplaza los datos y recalcula las secciones, quitando lo que ya no corresponde', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir([river, racing]);

    expect(m.getByRole('region', { name: 'En vivo' })).toBeInTheDocument();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));

    // Racing terminó (ya no es del directorio), River sigue y llegó un partido nuevo.
    await act(async () =>
      pedidos[0]!.resolver(
        jsonResponse({ matches: [{ ...racing, status: 'finished' }, river, nuevo] }),
      ),
    );

    await waitFor(() =>
      expect(m.queryByRole('region', { name: 'En vivo' })).not.toBeInTheDocument(),
    );
    expect(enlaces(m)).toEqual([
      'Ver partido: River Plate vs. Boca Juniors',
      'Ver partido: Lanús vs. Tigre',
    ]);
    expect(m.getByRole('region', { name: 'Próximos' })).toBeInTheDocument();
  });

  it('si ya no queda ningún partido visible muestra el vacío y conserva Actualizar', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir([river]);

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () =>
      pedidos[0]!.resolver(jsonResponse({ matches: [{ ...river, status: 'finished' }] })),
    );

    expect(
      await m.findByRole('heading', { level: 2, name: 'No hay partidos por ahora' }),
    ).toBeInTheDocument();
    expect(enlaces(m)).toEqual([]);
    expect(m.getByRole('button', { name: 'Actualizar' })).toBeInTheDocument();
  });

  it('evita solicitudes simultáneas: mientras actualiza, otro clic o Enter no piden de nuevo', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();
    const llamadasAntes = fetchSpy.mock.calls.length;

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    const boton = await m.findByRole('button', { name: 'Actualizando…' });

    await user.click(boton);
    await user.dblClick(boton);
    boton.focus();
    await user.keyboard('{Enter}');

    expect(pedidos).toHaveLength(1);
    expect(fetchSpy.mock.calls.length).toBe(llamadasAntes + 1);

    await act(async () => pedidos[0]!.resolver(jsonResponse({ matches: [river] })));
    await user.click(await m.findByRole('button', { name: 'Actualizar' }));

    await waitFor(() => expect(pedidos).toHaveLength(2));
  });

  it('el foco se queda en el botón mientras actualiza y se activa con el teclado', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();
    const boton = m.getByRole('button', { name: 'Actualizar' });

    boton.focus();
    await user.keyboard('{Enter}');

    expect(await m.findByRole('button', { name: 'Actualizando…' })).toHaveFocus();
    expect(pedidos).toHaveLength(1);
  });

  it('el icono gira mientras actualiza y no lo hace con movimiento reducido', async () => {
    const user = userEvent.setup();
    const { m } = await abrir();

    expect(m.getByRole('button', { name: 'Actualizar' }).querySelector('svg')).not.toHaveClass(
      'animate-spin',
    );

    await user.click(m.getByRole('button', { name: 'Actualizar' }));

    expect(
      (await m.findByRole('button', { name: 'Actualizando…' })).querySelector('svg'),
    ).toHaveClass('animate-spin', 'motion-reduce:animate-none');
  });

  it('si falla conserva las tarjetas y muestra un error recuperable con Reintentar', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () => pedidos[0]!.rechazar(new TypeError('Failed to fetch')));

    const alerta = await m.findByRole('alert');

    expect(
      within(alerta).getByRole('heading', { level: 2, name: 'No pudimos actualizar' }),
    ).toBeInTheDocument();
    expect(alerta).toHaveTextContent('No pudimos conectarnos.');
    expect(alerta).toHaveTextContent('Seguimos mostrando el último listado.');
    expect(within(alerta).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(enlaces(m)).toEqual([
      'Ver partido: Racing Club vs. Independiente',
      'Ver partido: River Plate vs. Boca Juniors',
    ]);
    expect(m.queryByRole('heading', { name: 'Algo salió mal' })).not.toBeInTheDocument();
    expect(m.getByRole('button', { name: 'Actualizar' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('un 500 al actualizar también conserva las tarjetas', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () =>
      pedidos[0]!.resolver(
        jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error.' } }, 500),
      ),
    );

    expect(await m.findByRole('alert')).toHaveTextContent('No pudimos actualizar');
    expect(enlaces(m)).toHaveLength(2);
  });

  it('Reintentar vuelve a consultar, reemplaza los datos, quita el aviso y deja el foco en Actualizar', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () => pedidos[0]!.rechazar(new TypeError('Failed to fetch')));
    await user.click(
      within(await m.findByRole('alert')).getByRole('button', { name: 'Reintentar' }),
    );

    await waitFor(() => expect(pedidos).toHaveLength(2));
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(await m.findByRole('button', { name: 'Actualizando…' })).toHaveFocus();
    expect(enlaces(m)).toHaveLength(2);

    await act(async () => pedidos[1]!.resolver(jsonResponse({ matches: [nuevo] })));

    expect(await m.findByText(/Lanús/)).toBeInTheDocument();
    expect(enlaces(m)).toEqual(['Ver partido: Lanús vs. Tigre']);
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    expect(m.getByRole('button', { name: 'Actualizar' })).toHaveFocus();
  });

  it('una actualización exitosa no deja el aviso de un fallo anterior', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () => pedidos[0]!.rechazar(new TypeError('Failed to fetch')));
    await m.findByRole('alert');

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(2));
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => pedidos[1]!.resolver(jsonResponse({ matches: [river] })));

    await m.findByRole('button', { name: 'Actualizar' });
    expect(m.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('la sesión vencida durante una actualización sigue el tratamiento de siempre', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () =>
      pedidos[0]!.resolver(
        jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'No autenticado.' } }, 401),
      ),
    );

    const alerta = await m.findByRole('alert');

    expect(
      within(alerta).getByRole('heading', { level: 2, name: 'Necesitás ingresar de nuevo' }),
    ).toBeInTheDocument();
    expect(m.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(within(alerta).getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('al desmontar cancela la actualización en curso y descarta su respuesta', async () => {
    const user = userEvent.setup();
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { m, pedidos, vista } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0]!.signal?.aborted).toBe(false);

    vista.unmount();

    await waitFor(() => expect(pedidos[0]!.signal?.aborted).toBe(true));
    await act(async () => pedidos[0]!.resolver(jsonResponse({ matches: [nuevo] })));

    expect(errores).not.toHaveBeenCalled();
    errores.mockRestore();
  });

  it('descarta la respuesta de una sesión anterior y usa la de la sesión vigente', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));

    act(() => alCambiarSesion()('SIGNED_IN', otraSesion));

    // El cambio de sesión cancela la consulta anterior y dispara la de la nueva.
    await waitFor(() => expect(pedidos).toHaveLength(2));
    expect(pedidos[0]!.signal?.aborted).toBe(true);
    expect(pedidos[1]!.bearer).toBe('Bearer token-otro');

    await act(async () => pedidos[1]!.resolver(jsonResponse({ matches: [nuevo] })));
    expect(await m.findByText(/Lanús/)).toBeInTheDocument();

    // La respuesta tardía de la sesión anterior no pisa lo vigente.
    await act(async () => pedidos[0]!.resolver(jsonResponse({ matches: [racing] })));

    expect(enlaces(m)).toEqual(['Ver partido: Lanús vs. Tigre']);
    expect(m.getByRole('button', { name: 'Actualizar' })).toBeInTheDocument();
  });

  it('sólo consulta el catálogo persistido: una petición por pulsación, sin Supabase ni otras rutas', async () => {
    const user = userEvent.setup();
    const { m, pedidos } = await abrir();

    await user.click(m.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    await act(async () => pedidos[0]!.resolver(jsonResponse({ matches: [river] })));
    await m.findByRole('button', { name: 'Actualizar' });

    const destinos = (fetchSpy.mock.calls as [string, RequestInit][]).map(([url]) => String(url));

    expect(destinos).toEqual([MATCHES_URL, MATCHES_URL]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('conserva el filtro Mi equipo al actualizar y lo aplica a los datos nuevos', async () => {
    const user = userEvent.setup();
    const perfilUrl = `${API_BASE}/me/profile`;
    let actualizacion: (respuesta: Response) => void = () => {};
    let consultasAlCatalogo = 0;

    conSesion();
    fetchSpy.mockImplementation((input: unknown) => {
      if (String(input) === perfilUrl) {
        return Promise.resolve(
          jsonResponse({
            profile: { displayName: 'M', bio: '', favoriteTeamId: 'team-river-plate' },
          }),
        );
      }

      consultasAlCatalogo += 1;

      return consultasAlCatalogo === 1
        ? Promise.resolve(jsonResponse({ matches: [river, racing] }))
        : new Promise<Response>((resolver) => (actualizacion = resolver));
    });

    renderAt('/rooms');
    const m = await directorio();
    await user.click(await m.findByRole('button', { name: 'Mi equipo' }));
    await waitFor(() => expect(enlaces(m)).toEqual(['Ver partido: River Plate vs. Boca Juniors']));

    await user.click(m.getByRole('button', { name: 'Actualizar' }));

    // Mientras actualiza el filtro sigue elegido y las tarjetas filtradas siguen a la vista.
    expect(await m.findByRole('button', { name: 'Actualizando…' })).toBeInTheDocument();
    expect(m.getByRole('button', { name: 'Mi equipo' })).toHaveAttribute('aria-pressed', 'true');
    expect(enlaces(m)).toEqual(['Ver partido: River Plate vs. Boca Juniors']);

    // River pasó a jugarse en vivo y llegó un partido nuevo que no es del favorito.
    await act(async () =>
      actualizacion(jsonResponse({ matches: [{ ...river, status: 'live' }, racing, nuevo] })),
    );

    await waitFor(() => expect(m.getByRole('region', { name: 'En vivo' })).toBeInTheDocument());
    expect(m.getByRole('button', { name: 'Mi equipo' })).toHaveAttribute('aria-pressed', 'true');
    expect(m.queryByRole('region', { name: 'Próximos' })).not.toBeInTheDocument();
    expect(enlaces(m)).toEqual(['Ver partido: River Plate vs. Boca Juniors']);
    expect(consultasAlCatalogo).toBe(2);
  });
});
