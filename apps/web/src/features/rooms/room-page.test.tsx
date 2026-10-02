import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const API_BASE = 'https://api.watchparty.test';

const { authMock, fromMock, subscribeMock } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() },
  fromMock: vi.fn(),
  subscribeMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: authMock, from: fromMock } }));
vi.mock('@/lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  }),
}));
vi.mock('@/features/comments/realtime', () => ({ subscribeToRoomComments: subscribeMock }));

const { AuthProvider } = await import('@/auth/AuthProvider');
const { AppRoutes } = await import('@/app/router');

const session = { access_token: 'token-123', user: { id: 'user-1', email: 'a@b.com' } } as Session;

const sala = {
  id: 'room-123',
  matchId: 'match-001',
  createdAt: '2026-09-18T21:00:00.000Z',
};

const partido = {
  id: 'match-001',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'live',
};

const PARTIDO_URL = `${API_BASE}/matches/match-001`;
const TITULO_PARTIDO = 'River Plate vs. Boca Juniors';

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const COMENTARIOS_URL = `${API_BASE}/rooms/room-123/comments`;

/** La lista de comentarios, con o sin parámetros de paginación. */
function esComentarios(input: unknown): boolean {
  return new URL(String(input)).pathname.endsWith('/comments');
}

function esPartido(input: unknown): boolean {
  return String(input).startsWith(`${API_BASE}/matches/`);
}

/**
 * La lista de comentarios y el partido del encabezado piden sus propias URL:
 * se responden con una lista vacía y un partido válido para que las pruebas de
 * la sala no dependan de ellos.
 */
function responderCon(body: unknown, status = 200) {
  fetchSpy.mockImplementation((input: unknown) =>
    Promise.resolve(
      esPartido(input)
        ? jsonResponse({ match: partido })
        : esComentarios(input)
          ? jsonResponse({ comments: [] })
          : jsonResponse(body, status),
    ),
  );
}

/** Llamadas a una URL, sin distinguir su query string (la lista pagina con `?limit=`). */
function llamadasA(url: string): [string, RequestInit][] {
  return (fetchSpy.mock.calls as [string, RequestInit][]).filter(
    ([destino]) => String(destino).split('?')[0] === url,
  );
}

/** Simula navegar dentro de la SPA a otra sala sin pasar por otra pantalla. */
function IrAOtraSala() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/rooms/desconocida')}>
      Ir a otra sala
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <IrAOtraSala />
      </MemoryRouter>
    </AuthProvider>,
  );
}

/**
 * Consultas acotadas a la región principal: el Header monta un `role="alert"`
 * permanente que CSS oculta cuando está vacío, y jsdom no evalúa CSS.
 */
async function pantalla() {
  return within(await screen.findByRole('main'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  responderCon({ room: sala });
  authMock.getSession.mockResolvedValue({ data: { session }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  subscribeMock.mockReturnValue(vi.fn());
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('Sala: éxito', () => {
  it('abre por URL directa, consulta la API con bearer y muestra esa sala', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(
      await p.findByRole('heading', { level: 1, name: 'Sala del partido' }),
    ).toBeInTheDocument();
    const llamadas = llamadasA(`${API_BASE}/rooms/room-123`);
    const [, init] = llamadas[0] as [string, RequestInit];

    expect(llamadas).toHaveLength(1);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('anuncia la carga', async () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));

    renderAt('/rooms/room-123');

    expect(await (await pantalla()).findByRole('status')).toHaveTextContent('Cargando la sala…');
  });

  it('muestra el formulario y la lista de comentarios de la sala', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByLabelText('Comentario')).toBeInTheDocument();
    expect(
      await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.'),
    ).toBeInTheDocument();

    const llamadas = llamadasA(COMENTARIOS_URL);
    const [, init] = llamadas[0] as [string, RequestInit];

    expect(llamadas).toHaveLength(1);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('un comentario publicado aparece en la lista sin recargar', async () => {
    const user = userEvent.setup();
    const creado = {
      id: 'comentario-1',
      roomId: 'room-123',
      body: '¡Qué golazo!',
      createdAt: '2026-09-24T21:00:00.000Z',
    };

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.');

    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ comment: creado }, 201)));

    await user.type(p.getByLabelText('Comentario'), creado.body);
    await user.click(p.getByRole('button', { name: 'Comentar' }));

    expect(await p.findByText(creado.body)).toBeInTheDocument();
  });

  it('escucha los comentarios en vivo de la sala y cancela al salir', async () => {
    const cancelar = vi.fn();
    subscribeMock.mockReturnValue(cancelar);

    const { unmount } = renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByRole('heading', { name: TITULO_PARTIDO });

    await waitFor(() =>
      expect(subscribeMock).toHaveBeenCalledWith('room-123', expect.any(Function), {
        onStatusChange: expect.any(Function),
      }),
    );
    expect(cancelar).not.toHaveBeenCalled();

    unmount();

    expect(cancelar).toHaveBeenCalledTimes(1);
  });

  it('los comentarios que llegan en vivo aparecen todos, sin duplicarse', async () => {
    const primero = {
      id: 'comentario-1',
      roomId: 'room-123',
      body: '¡Qué golazo!',
      createdAt: '2026-09-24T21:00:00.000Z',
    };
    const segundo = { ...primero, id: 'comentario-2', body: 'Increíble jugada' };

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.');
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled());

    const [, recibir] = subscribeMock.mock.calls[0] as [string, (comentario: unknown) => void];

    act(() => {
      recibir(primero);
      recibir(segundo);
      recibir(primero);
    });

    expect(await p.findByText(primero.body)).toBeInTheDocument();
    expect(p.getByText(segundo.body)).toBeInTheDocument();
    expect(p.getAllByRole('listitem')).toHaveLength(2);
  });

  it('si la lista responde 401 ofrece reingresar con el flujo de Auth', async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esPartido(input)
          ? jsonResponse({ match: partido })
          : esComentarios(input)
            ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401)
            : jsonResponse({ room: sala }),
      ),
    );

    renderAt('/rooms/room-123');

    const p = await pantalla();

    await user.click(await p.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('redirige a /login sin sesión', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });

    renderAt('/rooms/room-123');

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });
});

describe('Sala: conexión de los comentarios en vivo', () => {
  const AVISO = 'Los comentarios no se están actualizando en vivo.';
  const comentario = {
    id: 'comentario-1',
    roomId: 'room-123',
    body: '¡Qué golazo!',
    createdAt: '2026-09-24T21:00:00.000Z',
  };

  /** Simula el aviso de estado de la suscripción número `indice` (0 = la primera). */
  function avisarConexion(estado: 'connected' | 'disconnected', indice = 0) {
    const [, , opciones] = subscribeMock.mock.calls[indice] as [
      string,
      unknown,
      { onStatusChange: (estado: string) => void },
    ];

    act(() => opciones.onStatusChange(estado));
  }

  async function abrirSala() {
    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.');
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));

    return p;
  }

  it('mientras la suscripción todavía no respondió no muestra el aviso', async () => {
    const p = await abrirSala();

    expect(p.queryByText(AVISO)).not.toBeInTheDocument();
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('conectada no muestra el aviso ni el botón', async () => {
    const p = await abrirSala();

    avisarConexion('connected');

    expect(p.queryByText(AVISO)).not.toBeInTheDocument();
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('desconectada anuncia que los comentarios no se actualizan y ofrece reintentar', async () => {
    const p = await abrirSala();

    avisarConexion('connected');
    avisarConexion('disconnected');

    expect(p.getByRole('status')).toHaveTextContent(AVISO);
    expect(p.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('también avisa si la suscripción falla antes de conectar', async () => {
    const p = await abrirSala();

    avisarConexion('disconnected');

    expect(p.getByRole('status')).toHaveTextContent(AVISO);
  });

  it('reintentar cancela la suscripción caída y vuelve a suscribirse una sola vez', async () => {
    const user = userEvent.setup();
    const cancelar = vi.fn();
    subscribeMock.mockReturnValue(cancelar);
    const p = await abrirSala();

    avisarConexion('disconnected');
    const boton = p.getByRole('button', { name: 'Reintentar' });
    await user.click(boton);
    await user.click(boton);

    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenLastCalledWith('room-123', expect.any(Function), {
      onStatusChange: expect.any(Function),
    });
    // Sólo se reinicia la suscripción: ni la sala ni la lista se vuelven a pedir.
    expect(llamadasA(`${API_BASE}/rooms/room-123`)).toHaveLength(1);
    expect(llamadasA(COMENTARIOS_URL)).toHaveLength(1);
  });

  it('tras reconectar el aviso desaparece', async () => {
    const user = userEvent.setup();
    const p = await abrirSala();

    avisarConexion('disconnected');
    await user.click(p.getByRole('button', { name: 'Reintentar' }));
    avisarConexion('connected', 1);

    expect(p.queryByText(AVISO)).not.toBeInTheDocument();
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('si el reintento también falla, vuelve a ofrecer reintentar', async () => {
    const user = userEvent.setup();
    const p = await abrirSala();

    avisarConexion('disconnected');
    await user.click(p.getByRole('button', { name: 'Reintentar' }));
    avisarConexion('disconnected', 1);
    await user.click(p.getByRole('button', { name: 'Reintentar' }));

    expect(subscribeMock).toHaveBeenCalledTimes(3);
  });

  it('ignora los avisos de una suscripción ya reemplazada', async () => {
    const user = userEvent.setup();
    const p = await abrirSala();

    avisarConexion('disconnected');
    await user.click(p.getByRole('button', { name: 'Reintentar' }));
    avisarConexion('connected', 1);
    avisarConexion('disconnected', 0);

    expect(p.queryByText(AVISO)).not.toBeInTheDocument();
  });

  it('la lista y el borrador sobreviven a la desconexión y al reintento', async () => {
    const user = userEvent.setup();
    const p = await abrirSala();
    const [, recibir] = subscribeMock.mock.calls[0] as [string, (comentario: unknown) => void];

    avisarConexion('connected');
    act(() => recibir(comentario));
    await user.type(p.getByLabelText('Comentario'), 'Borrador sin enviar');

    avisarConexion('disconnected');

    expect(p.getByText(comentario.body)).toBeInTheDocument();
    expect(p.getByLabelText('Comentario')).toHaveValue('Borrador sin enviar');

    await user.click(p.getByRole('button', { name: 'Reintentar' }));
    avisarConexion('connected', 1);

    expect(p.getByText(comentario.body)).toBeInTheDocument();
    expect(p.getByLabelText('Comentario')).toHaveValue('Borrador sin enviar');
  });
});

describe('Sala: reconciliación de comentarios al reconectar', () => {
  const previo = {
    id: 'comentario-1',
    roomId: 'room-123',
    body: 'Llegó antes de la caída',
    createdAt: '2026-09-24T21:00:00.000Z',
  };
  const perdido = {
    id: 'comentario-2',
    roomId: 'room-123',
    body: 'Se publicó durante la caída',
    createdAt: '2026-09-24T21:01:00.000Z',
  };
  const posterior = {
    id: 'comentario-3',
    roomId: 'room-123',
    body: 'Llegó en vivo después de reconectar',
    createdAt: '2026-09-24T21:02:00.000Z',
  };

  function avisarConexion(estado: 'connected' | 'disconnected', indice = 0) {
    const [, , opciones] = subscribeMock.mock.calls[indice] as [
      string,
      unknown,
      { onStatusChange: (estado: string) => void },
    ];

    act(() => opciones.onStatusChange(estado));
  }

  function recibirEnVivo(comentario: unknown, indice = 0) {
    const [, recibir] = subscribeMock.mock.calls[indice] as [string, (c: unknown) => void];

    act(() => recibir(comentario));
  }

  /** A partir de acá, la lista REST de la sala responde con estos comentarios. */
  function responderComentarios(comments: unknown[]) {
    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esPartido(input)
          ? jsonResponse({ match: partido })
          : esComentarios(input)
            ? jsonResponse({ comments })
            : jsonResponse({ room: sala }),
      ),
    );
  }

  async function abrirSala() {
    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.');
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));

    return p;
  }

  it('la primera conexión no vuelve a pedir los comentarios', async () => {
    await abrirSala();

    avisarConexion('connected');

    expect(llamadasA(COMENTARIOS_URL)).toHaveLength(1);
  });

  it('al recuperar la conexión vuelve a cargar los comentarios de la sala, una sola vez', async () => {
    await abrirSala();

    avisarConexion('connected');
    avisarConexion('disconnected');
    avisarConexion('connected');

    await waitFor(() => expect(llamadasA(COMENTARIOS_URL)).toHaveLength(2));
    const [, init] = llamadasA(COMENTARIOS_URL)[1] as [string, RequestInit];

    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
    // La sala no se vuelve a pedir: sólo los comentarios.
    expect(llamadasA(`${API_BASE}/rooms/room-123`)).toHaveLength(1);
  });

  it('también recarga cuando la conexión vuelve por un reintento', async () => {
    const user = userEvent.setup();
    const p = await abrirSala();

    avisarConexion('disconnected');
    await user.click(p.getByRole('button', { name: 'Reintentar' }));

    expect(llamadasA(COMENTARIOS_URL)).toHaveLength(1);

    avisarConexion('connected', 1);

    await waitFor(() => expect(llamadasA(COMENTARIOS_URL)).toHaveLength(2));
  });

  it('fusiona por id: el repetido queda una vez, el perdido aparece y el orden es cronológico', async () => {
    const p = await abrirSala();

    avisarConexion('connected');
    recibirEnVivo(previo);
    avisarConexion('disconnected');

    responderComentarios([previo, perdido]);
    avisarConexion('connected');
    recibirEnVivo(posterior);

    expect(await p.findByText(perdido.body)).toBeInTheDocument();
    expect(p.getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent)).toEqual([
      previo.body,
      perdido.body,
      posterior.body,
    ]);
  });

  it('el borrador sin enviar no cambia durante la reconciliación', async () => {
    const user = userEvent.setup();
    const p = await abrirSala();

    avisarConexion('connected');
    await user.type(p.getByLabelText('Comentario'), 'Borrador sin enviar');
    avisarConexion('disconnected');

    responderComentarios([perdido]);
    avisarConexion('connected');

    expect(await p.findByText(perdido.body)).toBeInTheDocument();
    expect(p.getByLabelText('Comentario')).toHaveValue('Borrador sin enviar');
  });
});

describe('Sala: paginación de comentarios', () => {
  const primero = {
    id: 'c1111111-1111-4111-8111-111111111111',
    roomId: 'room-123',
    body: 'Primer comentario',
    createdAt: '2026-09-24T21:00:00.000Z',
  };
  const segundo = {
    id: 'c2222222-2222-4222-8222-222222222222',
    roomId: 'room-123',
    body: 'Segundo comentario',
    createdAt: '2026-09-24T21:01:00.000Z',
  };
  const cursor = { createdAt: '2026-09-24T21:00:00.123456+00:00', id: primero.id };

  it('cargar más comentarios trae la página siguiente y conserva el borrador', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation((input: unknown) => {
      if (esPartido(input)) return Promise.resolve(jsonResponse({ match: partido }));
      if (!esComentarios(input)) return Promise.resolve(jsonResponse({ room: sala }));

      return Promise.resolve(
        new URL(String(input)).searchParams.get('beforeId') === cursor.id
          ? jsonResponse({ comments: [segundo], nextCursor: null })
          : jsonResponse({ comments: [primero], nextCursor: cursor }),
      );
    });

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByText(primero.body);
    await user.type(p.getByLabelText('Comentario'), 'Borrador sin enviar');
    await user.click(p.getByRole('button', { name: 'Cargar más comentarios' }));

    expect(await p.findByText(segundo.body)).toBeInTheDocument();
    expect(p.getByText(primero.body)).toBeInTheDocument();
    expect(p.getByLabelText('Comentario')).toHaveValue('Borrador sin enviar');
    expect(p.queryByRole('button', { name: 'Cargar más comentarios' })).not.toBeInTheDocument();
    expect(llamadasA(COMENTARIOS_URL)).toHaveLength(2);
  });
});

describe('Sala: encabezado del partido', () => {
  const ERROR_PARTIDO = 'No pudimos cargar los datos del partido.';
  const REINTENTAR_PARTIDO = 'Reintentar la carga del partido';

  /** El partido del encabezado falla con un 500; sala y comentarios responden bien. */
  function partidoFalla() {
    fetchSpy.mockImplementation((input: unknown) =>
      Promise.resolve(
        esPartido(input)
          ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
          : esComentarios(input)
            ? jsonResponse({ comments: [] })
            : jsonResponse({ room: sala }),
      ),
    );
  }

  it('pide el partido de la sala con bearer y muestra los equipos en vez del UUID', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('heading', { name: TITULO_PARTIDO })).toBeInTheDocument();
    expect(p.queryByText('room-123')).not.toBeInTheDocument();
    expect(p.queryByText('Identificador de sala')).not.toBeInTheDocument();

    const llamadas = llamadasA(PARTIDO_URL);
    const [, init] = llamadas[0] as [string, RequestInit];

    expect(llamadas).toHaveLength(1);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('muestra el horario en hora local y el estado del partido', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByRole('heading', { name: TITULO_PARTIDO });

    // 21:00 UTC son las 18:00 en Argentina.
    expect(p.getByText(/18:00/)).toBeInTheDocument();
    expect(p.getByText('En vivo')).toBeInTheDocument();
  });

  it('enlaza al detalle del partido por su id opaco, con nombre accesible', async () => {
    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('link', { name: `Ver partido: ${TITULO_PARTIDO}` })).toHaveAttribute(
      'href',
      '/matches/match-001',
    );
  });

  it('en móvil los nombres de los equipos cortan línea en vez de desbordar', async () => {
    renderAt('/rooms/room-123');

    const titulo = await (await pantalla()).findByRole('heading', { name: TITULO_PARTIDO });

    expect(titulo.className).toMatch(/min-w-0/);
    expect(titulo.className).toMatch(/break-words/);
  });

  it('si el partido falla lo avisa y conserva la sala, el formulario y los comentarios', async () => {
    partidoFalla();

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent(ERROR_PARTIDO);
    expect(p.getByRole('button', { name: REINTENTAR_PARTIDO })).toBeInTheDocument();
    expect(p.getByRole('heading', { level: 1, name: 'Sala del partido' })).toBeInTheDocument();
    expect(p.getByLabelText('Comentario')).toBeInTheDocument();
    expect(
      await p.findByText('Todavía no hay comentarios. Sé el primero en comentar la jugada.'),
    ).toBeInTheDocument();
  });

  it('el reintento vuelve a pedir sólo el partido y conserva el borrador y los comentarios', async () => {
    const user = userEvent.setup();
    const comentario = {
      id: 'comentario-1',
      roomId: 'room-123',
      body: '¡Qué golazo!',
      createdAt: '2026-09-24T21:00:00.000Z',
    };
    partidoFalla();

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByRole('alert');
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    const [, recibir] = subscribeMock.mock.calls[0] as [string, (c: unknown) => void];
    act(() => recibir(comentario));
    await user.type(p.getByLabelText('Comentario'), 'Borrador sin enviar');

    responderCon({ room: sala });
    await user.click(p.getByRole('button', { name: REINTENTAR_PARTIDO }));

    expect(await p.findByRole('heading', { name: TITULO_PARTIDO })).toBeInTheDocument();
    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(p.getByLabelText('Comentario')).toHaveValue('Borrador sin enviar');
    expect(p.getByText(comentario.body)).toBeInTheDocument();
    expect(llamadasA(PARTIDO_URL)).toHaveLength(2);
    expect(llamadasA(`${API_BASE}/rooms/room-123`)).toHaveLength(1);
    expect(llamadasA(COMENTARIOS_URL)).toHaveLength(1);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it('al cambiar de sala cancela el partido anterior y no muestra su respuesta tardía', async () => {
    const user = userEvent.setup();
    const otraSala = { id: 'desconocida', matchId: 'match-002', createdAt: sala.createdAt };
    const otroPartido = {
      ...partido,
      id: 'match-002',
      homeTeam: 'Racing Club',
      awayTeam: 'Independiente',
    };
    let responderPartidoViejo: () => void = () => {};

    fetchSpy.mockImplementation((input: unknown) => {
      const url = String(input);

      if (url === PARTIDO_URL) {
        return new Promise<Response>((resolve) => {
          responderPartidoViejo = () => resolve(jsonResponse({ match: partido }));
        });
      }
      if (url === `${API_BASE}/matches/match-002`) {
        return Promise.resolve(jsonResponse({ match: otroPartido }));
      }
      if (esComentarios(url)) return Promise.resolve(jsonResponse({ comments: [] }));

      return Promise.resolve(
        jsonResponse({ room: url.endsWith('/rooms/desconocida') ? otraSala : sala }),
      );
    });

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await waitFor(() => expect(llamadasA(PARTIDO_URL)).toHaveLength(1));
    const [, init] = llamadasA(PARTIDO_URL)[0] as [string, RequestInit];

    await user.click(screen.getByRole('button', { name: 'Ir a otra sala' }));

    expect(init.signal?.aborted).toBe(true);
    expect(
      await p.findByRole('heading', { name: 'Racing Club vs. Independiente' }),
    ).toBeInTheDocument();

    await act(async () => {
      responderPartidoViejo();
    });

    expect(p.queryByRole('heading', { name: TITULO_PARTIDO })).not.toBeInTheDocument();
    expect(p.getByRole('heading', { name: 'Racing Club vs. Independiente' })).toBeInTheDocument();
  });
});

describe('Sala: estados alternativos', () => {
  it('un 404 se comunica como sala inexistente, no como error recuperable', async () => {
    responderCon({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' } }, 404);

    renderAt('/rooms/desconocida');

    const p = await pantalla();

    expect(await p.findByText('No encontramos esa sala.')).toBeInTheDocument();
    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('un 500 se anuncia como error recuperable y el reintento vuelve a consultar', async () => {
    const user = userEvent.setup();
    responderCon({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent(
      'No pudimos abrir la sala. Intentá de nuevo.',
    );

    responderCon({ room: sala });
    await user.click(p.getByRole('button', { name: 'Reintentar' }));

    expect(await p.findByRole('heading', { name: TITULO_PARTIDO })).toBeInTheDocument();
    expect(p.queryByRole('alert')).not.toBeInTheDocument();
    expect(llamadasA(`${API_BASE}/rooms/room-123`)).toHaveLength(2);
  });

  it('una caída de red se anuncia como error recuperable', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
    expect(p.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('ante un 401 ofrece reingresar con el flujo de Auth existente', async () => {
    const user = userEvent.setup();
    responderCon({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);

    renderAt('/rooms/room-123');

    const p = await pantalla();

    expect(await p.findByRole('alert')).toHaveTextContent(
      'La sesión venció. Iniciá sesión nuevamente.',
    );
    expect(p.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('al pasar a un id desconocido no deja visible la sala anterior', async () => {
    const user = userEvent.setup();

    renderAt('/rooms/room-123');

    const p = await pantalla();
    await p.findByRole('heading', { name: TITULO_PARTIDO });

    let responder404: () => void = () => {};
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          responder404 = () =>
            resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: 'x' } }, 404));
        }),
    );

    await user.click(screen.getByRole('button', { name: 'Ir a otra sala' }));

    expect(await p.findByRole('status')).toHaveTextContent('Cargando la sala…');
    expect(p.queryByRole('heading', { name: TITULO_PARTIDO })).not.toBeInTheDocument();

    responder404();

    expect(await p.findByText('No encontramos esa sala.')).toBeInTheDocument();
    expect(p.queryByRole('heading', { name: TITULO_PARTIDO })).not.toBeInTheDocument();
  });

  it('no monta comentarios si la sala no existe', async () => {
    responderCon({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' } }, 404);

    renderAt('/rooms/desconocida');

    const p = await pantalla();
    await p.findByText('No encontramos esa sala.');

    expect(p.queryByRole('textbox')).not.toBeInTheDocument();
    expect(llamadasA(`${API_BASE}/rooms/desconocida/comments`)).toHaveLength(0);
    expect(subscribeMock).not.toHaveBeenCalled();
  });
});
