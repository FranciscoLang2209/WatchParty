import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentList, type CommentListProps } from './CommentList';
import type { RoomComment } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const ROOM_ID = 'b2222222-2222-4222-8222-222222222222';

const COMMENT_1: RoomComment = {
  id: 'c1111111-1111-4111-8111-111111111111',
  roomId: ROOM_ID,
  body: 'Qué golazo',
  createdAt: '2026-09-19T12:00:00.000Z',
};

const COMMENT_2: RoomComment = {
  id: 'c2222222-2222-4222-8222-222222222222',
  roomId: ROOM_ID,
  body: 'Offside clarísimo',
  createdAt: '2026-09-19T12:05:00.000Z',
};

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function requestInit(callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex]![1] as RequestInit;
}

function renderList(props: Partial<CommentListProps> = {}) {
  const user = userEvent.setup();
  const onSessionExpired = vi.fn();

  const view = render(
    <CommentList
      roomId={ROOM_ID}
      accessToken={TOKEN}
      onSessionExpired={onSessionExpired}
      {...props}
    />,
  );

  return { user, onSessionExpired, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Descarta también las respuestas `Once` que una prueba haya dejado sin usar.
  fetchMock.mockReset();
  envMock.mockReturnValue({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CommentList: carga', () => {
  it('anuncia la carga inicial', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    renderList();

    expect(screen.getByRole('status')).toHaveTextContent('Cargando comentarios…');
  });

  it('consulta GET /rooms/:roomId/comments con bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [] }));

    renderList();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments?limit=20`);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });
});

describe('CommentList: lista vacía y con datos', () => {
  it('explica la lista vacía en vez de dejarla en blanco', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [] }));

    renderList();

    expect(await screen.findByText(/Todavía no hay comentarios/)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renderiza un ítem por comentario, en el orden que da el servidor', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1, COMMENT_2] }));

    renderList();

    const lista = await screen.findByRole('list');
    const items = within(lista).getAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(COMMENT_1.body);
    expect(items[1]).toHaveTextContent(COMMENT_2.body);
  });

  it('el body se muestra como texto, nunca como HTML', async () => {
    const comentarioConHtml: RoomComment = { ...COMMENT_1, body: '<b>gol</b>' };
    fetchMock.mockResolvedValue(jsonResponse({ comments: [comentarioConHtml] }));

    const { container } = renderList();

    expect(await screen.findByText('<b>gol</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).not.toBeInTheDocument();
  });
});

describe('CommentList: error y reintento', () => {
  it('una caída de red se anuncia como error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderList();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos conectarnos');
  });

  it('el botón Reintentar vuelve a consultar la API', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { user } = renderList();

    await screen.findByRole('alert');

    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText(COMMENT_1.body)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un 401 ofrece reingresar y llama a onSessionExpired', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401));
    const { user, onSessionExpired } = renderList();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('La sesión venció. Iniciá sesión nuevamente.');
    // No se ofrece reintentar: reintentar con un token vencido no sirve.
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('sin onSessionExpired, un 401 muestra el mensaje sin botón', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401));

    renderList({ onSessionExpired: undefined });

    await screen.findByRole('alert');

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('CommentList: comentario nuevo desde el form', () => {
  it('agrega newComment al final de la lista', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));

    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComments={[COMMENT_2]} />);

    const lista = await screen.findByRole('list');
    const items = within(lista).getAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent(COMMENT_2.body);
  });

  it('ubica en su lugar cronológico un newComment anterior a uno ya visible', async () => {
    const COMMENT_3: RoomComment = {
      id: 'c3333333-3333-4333-8333-333333333333',
      roomId: ROOM_ID,
      body: 'Tercer comentario',
      createdAt: '2026-09-19T12:10:00.000Z',
    };

    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1, COMMENT_3] }));

    const { rerender } = renderList();
    await screen.findByText(COMMENT_3.body);

    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComments={[COMMENT_2]} />);

    const items = within(await screen.findByRole('list')).getAllByRole('listitem');

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(COMMENT_1.body);
    expect(items[1]).toHaveTextContent(COMMENT_2.body);
    expect(items[2]).toHaveTextContent(COMMENT_3.body);
  });

  it('no duplica si newComment ya está en la lista', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1, COMMENT_2] }));

    const { rerender } = renderList();
    await screen.findByText(COMMENT_2.body);

    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComments={[COMMENT_2]} />);

    const lista = await screen.findByRole('list');
    expect(within(lista).getAllByRole('listitem')).toHaveLength(2);
  });

  it('conserva los comentarios nuevos anteriores cuando llegan más', async () => {
    const COMMENT_3 = { ...COMMENT_2, id: 'comment-3', body: 'Tercer comentario' };

    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));

    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComments={[COMMENT_2]} />);
    rerender(
      <CommentList roomId={ROOM_ID} accessToken={TOKEN} newComments={[COMMENT_2, COMMENT_3]} />,
    );

    const items = within(await screen.findByRole('list')).getAllByRole('listitem');

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(COMMENT_1.body);
    expect(items[1]).toHaveTextContent(COMMENT_2.body);
    expect(items[2]).toHaveTextContent(COMMENT_3.body);
  });
});

describe('CommentList: cancelación', () => {
  it('cancela el pedido al desmontar', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    const { unmount } = renderList();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const init = requestInit();
    expect(init.signal?.aborted).toBe(false);

    unmount();

    expect(init.signal?.aborted).toBe(true);
  });
});

describe('CommentList: paginación', () => {
  const CARGAR_MAS = 'Cargar más comentarios';
  const ERROR_MAS = 'No pudimos cargar más comentarios. Intentá de nuevo.';
  const COMMENT_3: RoomComment = {
    id: 'c3333333-3333-4333-8333-333333333333',
    roomId: ROOM_ID,
    body: 'Tercer comentario',
    createdAt: '2026-09-19T12:10:00.000Z',
  };
  const CURSOR_1 = { createdAt: '2026-09-19T12:00:00.123456+00:00', id: COMMENT_1.id };
  const CURSOR_2 = { createdAt: '2026-09-19T12:05:00.123456+00:00', id: COMMENT_2.id };

  function textos(): (string | null)[] {
    return within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.querySelector('p')?.textContent ?? null);
  }

  function urlDeLlamada(indice: number): URL {
    return new URL(fetchMock.mock.calls[indice]![0] as string);
  }

  /** Abre la lista con una primera página que deja más comentarios por cargar. */
  async function abrirConMasPorCargar(props: Partial<CommentListProps> = {}) {
    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_1], nextCursor: CURSOR_1 }));
    const vista = renderList(props);
    await screen.findByText(COMMENT_1.body);

    return vista;
  }

  it('la primera página pide 20 comentarios y ofrece cargar más si hay cursor', async () => {
    await abrirConMasPorCargar();

    expect(urlDeLlamada(0).searchParams.get('limit')).toBe('20');
    expect(urlDeLlamada(0).searchParams.has('beforeId')).toBe(false);
    expect(screen.getByRole('button', { name: CARGAR_MAS })).toBeInTheDocument();
  });

  it('sin cursor no ofrece cargar más', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1], nextCursor: null }));

    renderList();
    await screen.findByText(COMMENT_1.body);

    expect(screen.queryByRole('button', { name: CARGAR_MAS })).not.toBeInTheDocument();
  });

  it('cargar más pide la página siguiente con el cursor y la suma en orden', async () => {
    const { user } = await abrirConMasPorCargar();

    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_2], nextCursor: CURSOR_2 }));
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    await screen.findByText(COMMENT_2.body);
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body]);
    expect(urlDeLlamada(1).searchParams.get('limit')).toBe('20');
    expect(urlDeLlamada(1).searchParams.get('beforeCreatedAt')).toBe(CURSOR_1.createdAt);
    expect(urlDeLlamada(1).searchParams.get('beforeId')).toBe(CURSOR_1.id);
    // Queda otra página: la acción sigue disponible y usa el cursor nuevo.
    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_3], nextCursor: null }));
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    await screen.findByText(COMMENT_3.body);
    expect(urlDeLlamada(2).searchParams.get('beforeId')).toBe(CURSOR_2.id);
  });

  it('al llegar al final oculta la acción', async () => {
    const { user } = await abrirConMasPorCargar();

    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_2], nextCursor: null }));
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    await screen.findByText(COMMENT_2.body);
    expect(screen.queryByRole('button', { name: CARGAR_MAS })).not.toBeInTheDocument();
  });

  it('bloquea pedidos simultáneos: dos clics seguidos piden una sola página', async () => {
    const { user } = await abrirConMasPorCargar();
    let responder: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        responder = resolve;
      }),
    );

    const boton = screen.getByRole('button', { name: CARGAR_MAS });
    await user.click(boton);
    await user.click(boton);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(boton).toHaveAttribute('aria-disabled', 'true');

    responder(jsonResponse({ comments: [COMMENT_2], nextCursor: null }));

    await screen.findByText(COMMENT_2.body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('si falla conserva los comentarios y el cursor, avisa y permite reintentar', async () => {
    const { user } = await abrirConMasPorCargar();

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    expect(await screen.findByRole('alert')).toHaveTextContent(ERROR_MAS);
    expect(textos()).toEqual([COMMENT_1.body]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_2], nextCursor: null }));
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    await screen.findByText(COMMENT_2.body);
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // El reintento usa el mismo cursor que el pedido fallido.
    expect(urlDeLlamada(2).searchParams.get('beforeId')).toBe(CURSOR_1.id);
    expect(urlDeLlamada(2).searchParams.get('beforeCreatedAt')).toBe(CURSOR_1.createdAt);
  });

  it('si cargar más responde 401 ofrece reingresar', async () => {
    const { user, onSessionExpired } = await abrirConMasPorCargar();

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401));
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));
    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('un comentario que llega por Realtime y también en la página queda una sola vez', async () => {
    const { user, rerender } = await abrirConMasPorCargar();
    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComments={[COMMENT_3]} />);
    await screen.findByText(COMMENT_3.body);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ comments: [COMMENT_2, COMMENT_3], nextCursor: null }),
    );
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    await screen.findByText(COMMENT_2.body);
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body, COMMENT_3.body]);
  });

  it('la recarga por reconexión pide la lista completa y oculta la paginación', async () => {
    const { rerender } = await abrirConMasPorCargar();

    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_1, COMMENT_2, COMMENT_3] }));
    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} reloadSignal={1} />);

    await screen.findByText(COMMENT_3.body);
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body, COMMENT_3.body]);
    // La recuperación es el listado completo de siempre: sin parámetros de página.
    expect(urlDeLlamada(1).search).toBe('');
    expect(screen.queryByRole('button', { name: CARGAR_MAS })).not.toBeInTheDocument();
  });

  it('una página pedida antes de la reconexión no vuelve a mostrar la paginación', async () => {
    const { user, rerender } = await abrirConMasPorCargar();
    let responderPagina: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        responderPagina = resolve;
      }),
    );
    await user.click(screen.getByRole('button', { name: CARGAR_MAS }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [COMMENT_1, COMMENT_2, COMMENT_3] }));
    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} reloadSignal={1} />);
    await screen.findByText(COMMENT_3.body);

    responderPagina(jsonResponse({ comments: [COMMENT_2], nextCursor: CURSOR_2 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body, COMMENT_3.body]);
    expect(screen.queryByRole('button', { name: CARGAR_MAS })).not.toBeInTheDocument();
  });
});

describe('CommentList: recarga por reconexión', () => {
  const ROOM_2 = 'b3333333-3333-4333-8333-333333333333';
  const COMMENT_3: RoomComment = {
    id: 'c3333333-3333-4333-8333-333333333333',
    roomId: ROOM_ID,
    body: 'Tercer comentario',
    createdAt: '2026-09-19T12:10:00.000Z',
  };

  function lista(props: Partial<CommentListProps> = {}) {
    return <CommentList roomId={ROOM_ID} accessToken={TOKEN} {...props} />;
  }

  function textos(): (string | null)[] {
    return within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.querySelector('p')?.textContent ?? null);
  }

  it('al cambiar reloadSignal vuelve a pedir la lista sin anunciar carga', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    fetchMock.mockReturnValue(new Promise(() => {}));
    rerender(lista({ reloadSignal: 1 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText(COMMENT_1.body)).toBeInTheDocument();
    expect(screen.queryByText('Cargando comentarios…')).not.toBeInTheDocument();
  });

  it('fusiona la respuesta con lo visible: sin duplicar y sumando el que faltaba', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1, COMMENT_2] }));
    rerender(lista({ reloadSignal: 1 }));

    await screen.findByText(COMMENT_2.body);
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body]);
  });

  it('el que faltaba queda en su lugar cronológico, antes de uno nuevo que ya estaba visible', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);
    rerender(lista({ newComments: [COMMENT_3] }));

    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1, COMMENT_2, COMMENT_3] }));
    rerender(lista({ newComments: [COMMENT_3], reloadSignal: 1 }));

    await screen.findByText(COMMENT_2.body);
    expect(textos()).toEqual([COMMENT_1.body, COMMENT_2.body, COMMENT_3.body]);
  });

  it('si la recarga falla conserva la lista visible en vez de reemplazarla por un error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    rerender(lista({ reloadSignal: 1 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(screen.getByText(COMMENT_1.body)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('si la recarga responde 401 ofrece reingresar', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401),
    );
    rerender(lista({ reloadSignal: 1, onSessionExpired: vi.fn() }));

    expect(
      await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }),
    ).toBeInTheDocument();
  });

  it('al cambiar de sala no mezcla los comentarios de la anterior', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1] }));
    const { rerender } = renderList();
    await screen.findByText(COMMENT_1.body);

    const deOtraSala = { ...COMMENT_2, roomId: ROOM_2 };
    fetchMock.mockResolvedValue(jsonResponse({ comments: [deOtraSala] }));
    rerender(lista({ roomId: ROOM_2 }));

    await screen.findByText(deOtraSala.body);
    expect(textos()).toEqual([deOtraSala.body]);
  });
});
