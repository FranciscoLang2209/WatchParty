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

    // Fuera de las tarjetas sólo queda el selector de estado.
    expect(m.getAllByRole('button').map((boton) => boton.textContent)).toEqual([
      'Todos',
      'En vivo',
      'Próximos',
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

  it('la lista vacía es un panel informativo: sin alerta, sin estado y sin botones', async () => {
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
    expect(m.queryByRole('button')).not.toBeInTheDocument();
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

describe('Directorio de salas — selector Todos / En vivo / Próximos', () => {
  const partido = (
    id: string,
    status: 'live' | 'scheduled' | 'finished' | 'cancelled' | 'postponed',
    homeTeam: string,
  ) => ({ ...river, id, status, homeTeam, homeTeamId: `team-${id}` });

  const vivoB = partido('vivo-b', 'live', 'Vivo B');
  const vivoA = partido('vivo-a', 'live', 'Vivo A');
  const proxB = partido('prox-b', 'scheduled', 'Prox B');
  const proxA = partido('prox-a', 'scheduled', 'Prox A');
  const finalizado = partido('finalizado', 'finished', 'Final');
  const cancelado = partido('cancelado', 'cancelled', 'Cancelado');
  const pospuesto = partido('pospuesto', 'postponed', 'Pospuesto');

  // Orden de la API deliberadamente mezclado: dentro de cada sección debe respetarse.
  const agenda = [proxB, vivoB, finalizado, proxA, cancelado, vivoA, pospuesto];

  async function abrir(matches: unknown[] = agenda) {
    conSesion();
    fetchSpy.mockResolvedValue(jsonResponse({ matches }));

    renderAt('/rooms');
    const m = await directorio();
    await m.findByRole('group', { name: 'Filtrar por estado' });

    return m;
  }

  function enlaces(m: ReturnType<typeof within>) {
    return m
      .queryAllByRole('link', { name: /Ver partido/ })
      .map((enlace: HTMLElement) =>
        enlace.getAttribute('aria-label')?.replace(/^Ver partido: | vs\..*$/g, ''),
      );
  }

  function opcion(m: ReturnType<typeof within>, nombre: string) {
    return m.getByRole('button', { name: nombre });
  }

  it('ofrece Todos, En vivo y Próximos en un grupo con nombre, con Todos elegido', async () => {
    const m = await abrir();
    const grupo = m.getByRole('group', { name: 'Filtrar por estado' });

    expect(
      within(grupo)
        .getAllByRole('button')
        .map((boton) => boton.textContent),
    ).toEqual(['Todos', 'En vivo', 'Próximos']);
    expect(opcion(m, 'Todos')).toHaveAttribute('aria-pressed', 'true');
    expect(opcion(m, 'En vivo')).toHaveAttribute('aria-pressed', 'false');
    expect(opcion(m, 'Próximos')).toHaveAttribute('aria-pressed', 'false');
    // El elegido no se distingue sólo por color: lleva un tilde decorativo.
    expect(opcion(m, 'Todos').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(opcion(m, 'En vivo').querySelector('svg')).toBeNull();
  });

  it('Todos muestra las dos secciones, con el orden de la API dentro de cada una y sin finalizados ni cancelados', async () => {
    const m = await abrir();
    const enVivo = m.getByRole('region', { name: 'En vivo' });
    const proximos = m.getByRole('region', { name: 'Próximos' });

    expect(enlaces(within(enVivo))).toEqual(['Vivo B', 'Vivo A']);
    expect(enlaces(within(proximos))).toEqual(['Prox B', 'Prox A']);
    expect(enlaces(m)).toEqual(['Vivo B', 'Vivo A', 'Prox B', 'Prox A']);
    expect(m.queryByText(/Final|Cancelado|Pospuesto/)).not.toBeInTheDocument();
  });

  it('En vivo deja sólo la sección En vivo, en el orden de la API', async () => {
    const user = userEvent.setup();
    const m = await abrir();

    await user.click(opcion(m, 'En vivo'));

    expect(opcion(m, 'En vivo')).toHaveAttribute('aria-pressed', 'true');
    expect(opcion(m, 'Todos')).toHaveAttribute('aria-pressed', 'false');
    expect(m.getByRole('region', { name: 'En vivo' })).toBeInTheDocument();
    expect(m.queryByRole('region', { name: 'Próximos' })).not.toBeInTheDocument();
    expect(enlaces(m)).toEqual(['Vivo B', 'Vivo A']);
  });

  it('Próximos deja sólo la sección Próximos, en el orden de la API', async () => {
    const user = userEvent.setup();
    const m = await abrir();

    await user.click(opcion(m, 'Próximos'));

    expect(opcion(m, 'Próximos')).toHaveAttribute('aria-pressed', 'true');
    expect(m.getByRole('region', { name: 'Próximos' })).toBeInTheDocument();
    expect(m.queryByRole('region', { name: 'En vivo' })).not.toBeInTheDocument();
    expect(enlaces(m)).toEqual(['Prox B', 'Prox A']);
  });

  it('volver a Todos restaura las dos secciones y ninguna opción incluye finalizados ni cancelados', async () => {
    const user = userEvent.setup();
    const m = await abrir();

    for (const nombre of ['En vivo', 'Próximos', 'Todos']) {
      await user.click(opcion(m, nombre));

      expect(m.queryByText(/Final|Cancelado|Pospuesto/)).not.toBeInTheDocument();
    }

    expect(enlaces(m)).toEqual(['Vivo B', 'Vivo A', 'Prox B', 'Prox A']);
    expect(m.getByRole('region', { name: 'En vivo' })).toBeInTheDocument();
    expect(m.getByRole('region', { name: 'Próximos' })).toBeInTheDocument();
  });

  it('conserva los títulos de sección como h2 y los partidos como h3 con cualquier opción', async () => {
    const user = userEvent.setup();
    const m = await abrir();

    await user.click(opcion(m, 'En vivo'));

    expect(m.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['En vivo']);
    expect(m.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(m.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('una opción sin partidos lo dice y permite volver a Todos, dejando el foco en Todos', async () => {
    const user = userEvent.setup();
    const m = await abrir([proxA, proxB]);

    await user.click(opcion(m, 'En vivo'));

    const aviso = await m.findByRole('status');

    expect(within(aviso).getByRole('heading', { level: 2 })).toHaveTextContent(
      'No hay partidos para mostrar',
    );
    expect(aviso).toHaveTextContent('No hay partidos en vivo por ahora.');
    expect(enlaces(m)).toEqual([]);
    expect(m.queryByRole('region')).not.toBeInTheDocument();

    await user.click(within(aviso).getByRole('button', { name: 'Ver todos los partidos' }));

    expect(opcion(m, 'Todos')).toHaveAttribute('aria-pressed', 'true');
    expect(opcion(m, 'Todos')).toHaveFocus();
    expect(enlaces(m)).toEqual(['Prox A', 'Prox B']);
  });

  it('Próximos sin partidos próximos también lo dice', async () => {
    const user = userEvent.setup();
    const m = await abrir([vivoA]);

    await user.click(opcion(m, 'Próximos'));

    expect(await m.findByRole('status')).toHaveTextContent('No hay partidos próximos por ahora.');
    expect(enlaces(m)).toEqual([]);
  });

  it('no se ofrece mientras carga, ante un error, sin partidos ni con partidos fuera del directorio', async () => {
    conSesion();
    fetchSpy.mockReturnValue(new Promise(() => {}));
    const cargando = renderAt('/rooms');
    const enCarga = await directorio();
    await enCarga.findByRole('status');
    expect(enCarga.queryByRole('group', { name: 'Filtrar por estado' })).not.toBeInTheDocument();
    cargando.unmount();

    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const conError = renderAt('/rooms');
    const enError = await directorio();
    await enError.findByRole('alert');
    expect(enError.queryByRole('group', { name: 'Filtrar por estado' })).not.toBeInTheDocument();
    conError.unmount();

    fetchSpy.mockResolvedValue(jsonResponse({ matches: [finalizado, cancelado] }));
    renderAt('/rooms');
    const sinVisibles = await directorio();
    await sinVisibles.findByText(/Todavía no hay partidos ni salas disponibles/);
    expect(
      sinVisibles.queryByRole('group', { name: 'Filtrar por estado' }),
    ).not.toBeInTheDocument();
  });

  it('se recorre con Tab en orden y se elige con Enter o Espacio, sin perder el foco', async () => {
    const user = userEvent.setup();
    const m = await abrir();

    opcion(m, 'Todos').focus();
    await user.tab();
    expect(opcion(m, 'En vivo')).toHaveFocus();
    await user.tab();
    expect(opcion(m, 'Próximos')).toHaveFocus();

    await user.keyboard(' ');
    expect(opcion(m, 'Próximos')).toHaveAttribute('aria-pressed', 'true');
    expect(opcion(m, 'Próximos')).toHaveFocus();
    expect(enlaces(m)).toEqual(['Prox B', 'Prox A']);

    await user.tab({ shift: true });
    expect(opcion(m, 'En vivo')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(opcion(m, 'En vivo')).toHaveAttribute('aria-pressed', 'true');
    expect(opcion(m, 'En vivo')).toHaveFocus();
    expect(enlaces(m)).toEqual(['Vivo B', 'Vivo A']);
  });

  it('cambiar de opción no vuelve a consultar la API: filtra lo ya cargado', async () => {
    const user = userEvent.setup();
    const m = await abrir();

    await user.click(opcion(m, 'En vivo'));
    await user.click(opcion(m, 'Próximos'));
    await user.click(opcion(m, 'Todos'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
