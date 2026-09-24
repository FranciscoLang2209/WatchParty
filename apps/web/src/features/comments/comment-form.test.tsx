import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentForm, type CommentFormProps } from './CommentForm';
import { BODY_MAX_LENGTH, type CommentInput, type RoomComment } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const ROOM_ID = 'b2222222-2222-4222-8222-222222222222';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMENT: RoomComment = {
  id: 'c3333333-3333-4333-8333-333333333333',
  roomId: ROOM_ID,
  body: 'Qué golazo',
  createdAt: '2026-09-19T12:00:00.000Z',
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

function requestUrl(callIndex = 0): string {
  return fetchMock.mock.calls[callIndex]![0] as string;
}

function requestInit(callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex]![1] as RequestInit;
}

function enviado(callIndex = 0): CommentInput {
  return JSON.parse(requestInit(callIndex).body as string) as CommentInput;
}

function renderForm(props: Partial<CommentFormProps> = {}) {
  const user = userEvent.setup();
  const onCommentCreated = vi.fn();

  render(
    <CommentForm
      roomId={ROOM_ID}
      accessToken={TOKEN}
      onCommentCreated={onCommentCreated}
      {...props}
    />,
  );

  return { user, onCommentCreated };
}

const campo = () => screen.getByLabelText('Comentario');
const enviar = () => screen.getByRole('button');

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

describe('CommentForm: qué se ve', () => {
  it('presenta el campo y el botón de envío', () => {
    renderForm();

    expect(campo()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeInTheDocument();
  });

  it('el contador arranca en 0/180', () => {
    renderForm();

    expect(screen.getByText(`0/${BODY_MAX_LENGTH}`)).toBeInTheDocument();
  });

  it('el contador acompaña lo que se tipea', async () => {
    const { user } = renderForm();

    await user.type(campo(), 'Gol');

    expect(screen.getByText(`3/${BODY_MAX_LENGTH}`)).toBeInTheDocument();
  });

  it('no consulta la API al montar', () => {
    renderForm();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CommentForm: envío exitoso', () => {
  it('manda POST /rooms/:roomId/comments con bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comment: COMMENT }, 201));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestUrl()).toBe(`${API_BASE}/rooms/${ROOM_ID}/comments`);
    expect(requestInit().method).toBe('POST');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('genera un clientRequestId con forma de UUID', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comment: COMMENT }, 201));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(enviado().clientRequestId).toMatch(UUID_RE);
  });

  it('limpia el campo y avisa el comentario creado', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comment: COMMENT }, 201));
    const { user, onCommentCreated } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());

    await waitFor(() => expect(onCommentCreated).toHaveBeenCalledWith(COMMENT));
    expect(campo()).toHaveValue('');
  });

  it('recorta los espacios antes de mandar', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comment: COMMENT }, 201));
    const { user } = renderForm();

    await user.type(campo(), `  ${COMMENT.body}  `);
    await user.click(enviar());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(enviado().body).toBe(COMMENT.body);
  });
});

describe('CommentForm: validación', () => {
  it('rechaza el envío vacío sin consultar la API', async () => {
    const { user } = renderForm();

    await user.click(enviar());

    expect(await screen.findByRole('alert')).toHaveTextContent('Escribí algo antes de enviar.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza un borrador de sólo espacios', async () => {
    const { user } = renderForm();

    await user.type(campo(), '   ');
    await user.click(enviar());

    expect(await screen.findByRole('alert')).toHaveTextContent('Escribí algo antes de enviar.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el error desaparece al editar', async () => {
    const { user } = renderForm();

    await user.click(enviar());
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(campo(), 'G');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('CommentForm: pendiente', () => {
  it('deshabilita el campo y el botón mientras espera la respuesta', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());

    await waitFor(() => expect(campo()).toBeDisabled());
    expect(enviar()).toBeDisabled();
    expect(enviar()).toHaveTextContent('Enviando…');
  });

  it('un segundo click mientras está pendiente no dispara un segundo pedido', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(enviar());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('CommentForm: fallo del servidor', () => {
  it('un 404 muestra el mensaje, conserva el borrador y no llama a onCommentCreated', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'NOT_FOUND' } }, 404));
    const { user, onCommentCreated } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());

    expect(await screen.findByRole('alert')).toHaveTextContent('No encontramos esa sala.');
    expect(campo()).toHaveValue(COMMENT.body);
    expect(onCommentCreated).not.toHaveBeenCalled();
    expect(enviar()).toBeEnabled();
  });

  it('un fallo de red también conserva el borrador', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
    );
    expect(campo()).toHaveValue(COMMENT.body);
  });
});

describe('CommentForm: reintento idempotente', () => {
  it('reusa el mismo clientRequestId si reintenta sin editar', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ comment: COMMENT }, 201));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const primerIntento = enviado(0).clientRequestId;

    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(enviado(1).clientRequestId).toBe(primerIntento);
  });

  it('genera un clientRequestId distinto si edita el borrador antes de reintentar', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ comment: COMMENT }, 201));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const primerIntento = enviado(0).clientRequestId;

    await user.type(campo(), '!');
    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(enviado(1).clientRequestId).not.toBe(primerIntento);
  });

  it('usa un clientRequestId distinto para el siguiente comentario tras un envío exitoso', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ comment: COMMENT }, 201));
    const { user } = renderForm();

    await user.type(campo(), COMMENT.body);
    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const primerIntento = enviado(0).clientRequestId;

    await user.type(campo(), 'Otro comentario');
    await user.click(enviar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(enviado(1).clientRequestId).not.toBe(primerIntento);
  });
});

describe('CommentForm: accesibilidad', () => {
  it('el campo sólo referencia el contador cuando no hay error', () => {
    renderForm();

    const contador = screen.getByText(`0/${BODY_MAX_LENGTH}`);

    expect(campo().getAttribute('aria-describedby')).toBe(contador.id);
    expect(campo()).toHaveAttribute('aria-invalid', 'false');
  });

  it('el campo referencia contador y error cuando el error está presente', async () => {
    const { user } = renderForm();

    await user.click(enviar());
    const alerta = await screen.findByRole('alert');
    const contador = screen.getByText(`0/${BODY_MAX_LENGTH}`);

    expect(campo().getAttribute('aria-describedby')).toBe(`${contador.id} ${alerta.id}`);
    expect(campo()).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('CommentForm: teclado', () => {
  it('recorre campo y botón en orden', async () => {
    const { user } = renderForm();

    await user.tab();
    expect(campo()).toHaveFocus();

    await user.tab();
    expect(enviar()).toHaveFocus();
  });
});
