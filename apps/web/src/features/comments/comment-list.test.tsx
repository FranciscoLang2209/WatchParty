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

    expect(url).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments`);
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

    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComment={COMMENT_2} />);

    const lista = await screen.findByRole('list');
    const items = within(lista).getAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent(COMMENT_2.body);
  });

  it('no duplica si newComment ya está en la lista', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comments: [COMMENT_1, COMMENT_2] }));

    const { rerender } = renderList();
    await screen.findByText(COMMENT_2.body);

    rerender(<CommentList roomId={ROOM_ID} accessToken={TOKEN} newComment={COMMENT_2} />);

    const lista = await screen.findByRole('list');
    expect(within(lista).getAllByRole('listitem')).toHaveLength(2);
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
