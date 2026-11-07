import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchReviewsList } from './MatchReviewsList';
import { ReviewsApiError, type PublicReview, type ReviewsPage } from './types';

const MATCH_ID = 'match-001';
const OTHER_MATCH_ID = 'match-002';
const TOKEN = 'token-abc';

const { listMatchReviewsMock } = vi.hoisted(() => ({ listMatchReviewsMock: vi.fn() }));

vi.mock('./api', () => ({ listMatchReviews: listMatchReviewsMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function review(n: number, overrides: Partial<PublicReview> = {}): PublicReview {
  return {
    authorName: `Persona ${n}`,
    body: `Opinión número ${n}`,
    createdAt: `2026-11-0${n}T10:00:00.000Z`,
    ...overrides,
  };
}

const page = (reviews: PublicReview[], nextCursor: string | null = null): ReviewsPage => ({
  reviews,
  nextCursor,
});

function apiError(kind: ConstructorParameters<typeof ReviewsApiError>[0], message = 'Falló.') {
  return new ReviewsApiError(kind, message);
}

interface ElementOptions {
  matchId?: string;
  accessToken?: string | null;
  refreshKey?: number;
  onSessionExpired?: () => void;
}

/** Mismo `key` que en el detalle: por partido. */
function element({
  matchId = MATCH_ID,
  accessToken = TOKEN,
  refreshKey = 0,
  onSessionExpired = () => {},
}: ElementOptions = {}) {
  return (
    <MatchReviewsList
      key={matchId}
      matchId={matchId}
      accessToken={accessToken}
      refreshKey={refreshKey}
      onSessionExpired={onSessionExpired}
    />
  );
}

function renderList(options: ElementOptions = {}) {
  const user = userEvent.setup();
  const onSessionExpired = options.onSessionExpired ?? vi.fn();
  const view = render(element({ ...options, onSessionExpired }));

  return { user, onSessionExpired, ...view };
}

const cargarMas = () => screen.getByRole('button', { name: 'Cargar más' });

beforeEach(() => {
  vi.clearAllMocks();
  listMatchReviewsMock.mockReset();
});

describe('Carga inicial', () => {
  it('mientras pide anuncia la carga y no la presenta como vacío', async () => {
    listMatchReviewsMock.mockReturnValue(deferred<ReviewsPage>().promise);

    renderList();

    expect(await screen.findByRole('status')).toHaveTextContent('Cargando las opiniones…');
    expect(screen.queryByText(/todavía no hay opiniones/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('pide la primera página con el partido, el bearer y una señal, sin cursor', async () => {
    listMatchReviewsMock.mockResolvedValue(page([]));

    renderList();
    await screen.findByText(/todavía no hay opiniones/i);

    expect(listMatchReviewsMock).toHaveBeenCalledTimes(1);
    expect(listMatchReviewsMock).toHaveBeenCalledWith(MATCH_ID, TOKEN, {
      signal: expect.any(AbortSignal),
    });
  });

  it('sin token no pide nada', async () => {
    renderList({ accessToken: null });

    expect(listMatchReviewsMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Cargando las opiniones…');
  });

  it('una renovación del token no vuelve a pedir', async () => {
    listMatchReviewsMock.mockResolvedValue(page([review(1)]));

    const { rerender } = renderList();
    await screen.findByText('Opinión número 1');

    rerender(element({ accessToken: 'token-renovado' }));

    expect(listMatchReviewsMock).toHaveBeenCalledTimes(1);
  });
});

describe('Vacío y con datos', () => {
  it('sin opiniones muestra un estado explícito y ningún «Cargar más»', async () => {
    listMatchReviewsMock.mockResolvedValue(page([]));

    renderList();

    expect(
      await screen.findByText('Todavía no hay opiniones para este partido.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('con datos muestra nombre visible, texto y fecha de cada opinión, en el orden recibido', async () => {
    listMatchReviewsMock.mockResolvedValue(page([review(2), review(1)]));

    renderList();

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Persona 2')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Opinión número 2')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Persona 1')).toBeInTheDocument();

    const fecha = items[0]!.querySelector('time');
    expect(fecha).toHaveAttribute('datetime', '2026-11-02T10:00:00.000Z');
    expect(fecha).toHaveTextContent('2 de nov de 2026');
    expect(screen.queryByText(/todavía no hay opiniones/i)).not.toBeInTheDocument();
  });

  it('una fecha ilegible se muestra tal cual, sin romper', async () => {
    listMatchReviewsMock.mockResolvedValue(page([review(1, { createdAt: 'no-es-fecha' })]));

    renderList();

    expect(await screen.findByText('no-es-fecha')).toBeInTheDocument();
  });

  it('es una sección con nombre y un título de nivel 2', async () => {
    listMatchReviewsMock.mockResolvedValue(page([review(1)]));

    renderList();
    await screen.findByText('Opinión número 1');

    const region = screen.getByRole('region', { name: 'Opiniones del partido' });
    expect(
      within(region).getByRole('heading', { level: 2, name: 'Opiniones del partido' }),
    ).toBeInTheDocument();
    expect(within(region).getByRole('list')).toBeInTheDocument();
  });

  it('el texto con HTML se ve como texto y no se ejecuta ni se inserta', async () => {
    const malicioso = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>negrita</b>';
    const autor = '<i>Yo</i>';
    listMatchReviewsMock.mockResolvedValue(
      page([review(1, { body: malicioso, authorName: autor })]),
    );

    const { container } = renderList();

    expect(await screen.findByText(malicioso)).toBeInTheDocument();
    expect(screen.getByText(autor)).toBeInTheDocument();
    expect(container.querySelector('img, script, b, i')).toBeNull();
  });
});

describe('Cargar más', () => {
  it('sin siguiente página no se ofrece', async () => {
    listMatchReviewsMock.mockResolvedValue(page([review(1)], null));

    renderList();
    await screen.findByText('Opinión número 1');

    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('pide la página siguiente con el cursor tal cual, suma las opiniones y mantiene el orden', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(4), review(3)], 'cursor-1'))
      .mockResolvedValueOnce(page([review(2), review(1)], null));

    const { user } = renderList();
    await screen.findByText('Opinión número 4');

    await user.click(cargarMas());

    expect(await screen.findByText('Opinión número 1')).toBeInTheDocument();
    expect(listMatchReviewsMock).toHaveBeenCalledTimes(2);
    expect(listMatchReviewsMock).toHaveBeenLastCalledWith(MATCH_ID, TOKEN, {
      cursor: 'cursor-1',
      signal: expect.any(AbortSignal),
    });
    expect(
      screen.getAllByRole('listitem').map((item) => within(item).getByText(/^Persona/).textContent),
    ).toEqual(['Persona 4', 'Persona 3', 'Persona 2', 'Persona 1']);
    // Se acabaron las páginas.
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('encadena varias páginas con el cursor de cada una', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(3)], 'c1'))
      .mockResolvedValueOnce(page([review(2)], 'c2'))
      .mockResolvedValueOnce(page([review(1)], null));

    const { user } = renderList();
    await screen.findByText('Opinión número 3');

    await user.click(cargarMas());
    await screen.findByText('Opinión número 2');
    await user.click(cargarMas());
    await screen.findByText('Opinión número 1');

    expect(listMatchReviewsMock.mock.calls.map(([, , options]) => options.cursor)).toEqual([
      undefined,
      'c1',
      'c2',
    ]);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('mientras pide queda deshabilitado, ocupado y anunciado, con lo cargado a la vista', async () => {
    const siguiente = deferred<ReviewsPage>();
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockReturnValueOnce(siguiente.promise);

    const { user } = renderList();
    await screen.findByText('Opinión número 2');

    await user.click(cargarMas());

    expect(await screen.findByRole('status')).toHaveTextContent('Cargando más opiniones…');
    expect(cargarMas()).toBeDisabled();
    expect(cargarMas()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Opinión número 2')).toBeInTheDocument();

    siguiente.resolve(page([review(1)], null));
    expect(await screen.findByText('Opinión número 1')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dos clics seguidos piden la página una sola vez', async () => {
    const siguiente = deferred<ReviewsPage>();
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockReturnValueOnce(siguiente.promise);

    const { user } = renderList();
    await screen.findByText('Opinión número 2');

    const boton = cargarMas();
    await user.dblClick(boton);

    siguiente.resolve(page([review(1)], null));
    await screen.findByText('Opinión número 1');

    expect(listMatchReviewsMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('no repite una opinión que la página siguiente vuelve a traer', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(3), review(2)], 'c1'))
      .mockResolvedValueOnce(page([review(2), review(1)], null));

    const { user } = renderList();
    await screen.findByText('Opinión número 3');

    await user.click(cargarMas());
    await screen.findByText('Opinión número 1');

    expect(screen.getAllByText('Opinión número 2')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('dos personas con el mismo texto y fecha pero otro nombre son opiniones distintas', async () => {
    listMatchReviewsMock.mockResolvedValue(
      page([
        review(1, { body: 'Igual' }),
        review(1, { body: 'Igual', authorName: 'Otra persona' }),
      ]),
    );

    renderList();

    expect(await screen.findAllByText('Igual')).toHaveLength(2);
  });

  it('mueve el foco a la primera opinión nueva', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(3), review(2)], 'c1'))
      .mockResolvedValueOnce(page([review(1)], null));

    const { user } = renderList();
    await screen.findByText('Opinión número 3');

    await user.click(cargarMas());
    await screen.findByText('Opinión número 1');

    await waitFor(() => expect(screen.getAllByRole('listitem')[2]).toHaveFocus());
  });

  it('se opera con el teclado', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockResolvedValueOnce(page([review(1)], null));

    const { user } = renderList();
    await screen.findByText('Opinión número 2');

    await user.tab();
    expect(cargarMas()).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Opinión número 1')).toBeInTheDocument();
  });
});

describe('Errores y reintento', () => {
  it('un error al cargar avisa, no se muestra como vacío y deja reintentar', async () => {
    listMatchReviewsMock
      .mockRejectedValueOnce(
        apiError('server', 'No pudimos cargar las opiniones. Intentá de nuevo.'),
      )
      .mockResolvedValueOnce(page([review(1)]));

    const { user } = renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos cargar las opiniones. Intentá de nuevo.',
    );
    expect(screen.queryByText(/todavía no hay opiniones/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Opinión número 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // El reintento vuelve a pedir la PRIMERA página.
    expect(listMatchReviewsMock.mock.calls[1]![2].cursor).toBeUndefined();
  });

  it('mientras reintenta vuelve a anunciar la carga', async () => {
    const reintento = deferred<ReviewsPage>();
    listMatchReviewsMock
      .mockRejectedValueOnce(apiError('network'))
      .mockReturnValueOnce(reintento.promise);

    const { user } = renderList();
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Cargando las opiniones…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('un error que no es de la API se muestra con un mensaje genérico y permite reintentar', async () => {
    listMatchReviewsMock.mockRejectedValueOnce(new Error('boom'));

    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos cargar las opiniones. Intentá de nuevo.',
    );
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('con la sesión vencida ofrece volver a iniciar sesión y no reintentar', async () => {
    listMatchReviewsMock.mockRejectedValue(
      apiError('unauthorized', 'La sesión venció. Iniciá sesión nuevamente.'),
    );

    const { user, onSessionExpired } = renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció.');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it.each(['not-found', 'validation'] as const)(
    'un error «%s» no es recuperable: avisa sin ofrecer reintentar',
    async (kind) => {
      listMatchReviewsMock.mockRejectedValue(apiError(kind, 'No se puede.'));

      renderList();

      expect(await screen.findByRole('alert')).toHaveTextContent('No se puede.');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
  );

  it('una consulta cancelada no se anuncia como error', async () => {
    listMatchReviewsMock.mockRejectedValue(apiError('cancelled', 'Consulta cancelada.'));

    renderList();

    expect(await screen.findByRole('status')).toHaveTextContent('Cargando las opiniones…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('si falla la página siguiente conserva lo ya cargado, avisa y reintenta el MISMO cursor', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(3), review(2)], 'c1'))
      .mockRejectedValueOnce(apiError('network', 'No pudimos conectarnos.'))
      .mockResolvedValueOnce(page([review(1)], null));

    const { user } = renderList();
    await screen.findByText('Opinión número 3');

    await user.click(cargarMas());

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos conectarnos.');
    // Nada de lo cargado se pierde ni se reemplaza por el error.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Opinión número 3')).toBeInTheDocument();
    expect(screen.getByText('Opinión número 2')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Opinión número 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(listMatchReviewsMock.mock.calls.map(([, , options]) => options.cursor)).toEqual([
      undefined,
      'c1',
      'c1',
    ]);
  });

  it('si la página siguiente falla por sesión vencida conserva lo cargado y ofrece iniciar sesión', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockRejectedValueOnce(apiError('unauthorized', 'La sesión venció.'));

    const { user, onSessionExpired } = renderList();
    await screen.findByText('Opinión número 2');

    await user.click(cargarMas());
    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Opinión número 2')).toBeInTheDocument();
  });

  it('una página siguiente cancelada no se anuncia ni quita el botón', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockRejectedValueOnce(apiError('cancelled'));

    const { user } = renderList();
    await screen.findByText('Opinión número 2');

    await user.click(cargarMas());

    await waitFor(() => expect(listMatchReviewsMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Actualización tras un cambio propio (refreshKey)', () => {
  it('al cambiar vuelve a pedir la PRIMERA página y reemplaza la lista sin duplicar', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2), review(1)], 'c1'))
      .mockResolvedValueOnce(page([review(3), review(2), review(1)], null));

    const { rerender } = renderList();
    await screen.findByText('Opinión número 2');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByText('Opinión número 3')).toBeInTheDocument();
    expect(listMatchReviewsMock).toHaveBeenCalledTimes(2);
    expect(listMatchReviewsMock.mock.calls[1]![2].cursor).toBeUndefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getAllByText('Opinión número 2')).toHaveLength(1);
    // Con la lista nueva ya no hay más páginas.
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('mientras llega la lista nueva no deja a la vista la vieja', async () => {
    const nueva = deferred<ReviewsPage>();
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(1)], null))
      .mockReturnValueOnce(nueva.promise);

    const { rerender } = renderList();
    await screen.findByText('Opinión número 1');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByRole('status')).toHaveTextContent('Cargando las opiniones…');
    expect(screen.queryByText('Opinión número 1')).not.toBeInTheDocument();

    nueva.resolve(page([review(2)], null));
    expect(await screen.findByText('Opinión número 2')).toBeInTheDocument();
  });

  it('una respuesta tardía de la lectura anterior se descarta', async () => {
    const vieja = deferred<ReviewsPage>();
    const nueva = deferred<ReviewsPage>();
    listMatchReviewsMock.mockReturnValueOnce(vieja.promise).mockReturnValueOnce(nueva.promise);

    const { rerender } = renderList();
    await screen.findByRole('status');
    rerender(element({ refreshKey: 1 }));

    nueva.resolve(page([review(2)], null));
    await screen.findByText('Opinión número 2');
    vieja.resolve(page([review(1)], null));

    await waitFor(() => expect(listMatchReviewsMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Opinión número 1')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('una página siguiente en vuelo se descarta si la lista se actualiza antes', async () => {
    const siguiente = deferred<ReviewsPage>();
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockReturnValueOnce(siguiente.promise)
      .mockResolvedValueOnce(page([review(3), review(2)], null));

    const { user, rerender } = renderList();
    await screen.findByText('Opinión número 2');
    await user.click(cargarMas());
    await screen.findByText('Cargando más opiniones…');

    rerender(element({ refreshKey: 1 }));
    await screen.findByText('Opinión número 3');

    siguiente.resolve(page([review(1)], null));
    await waitFor(() => expect(listMatchReviewsMock).toHaveBeenCalledTimes(3));

    expect(screen.queryByText('Opinión número 1')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // Y el botón de la lista nueva no quedó trabado por la página descartada.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('si la actualización falla avisa el error, no deja la lista vieja como vigente y permite reintentar', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(1)], null))
      .mockRejectedValueOnce(apiError('server', 'No pudimos cargar las opiniones.'))
      .mockResolvedValueOnce(page([review(2), review(1)], null));

    const { user, rerender } = renderList();
    await screen.findByText('Opinión número 1');

    rerender(element({ refreshKey: 1 }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar las opiniones.');
    expect(screen.queryByText('Opinión número 1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Opinión número 2')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Otro partido y desmontaje', () => {
  it('no muestra opiniones de otro partido: la respuesta tardía del anterior se descarta', async () => {
    const delA = deferred<ReviewsPage>();
    const delB = deferred<ReviewsPage>();
    listMatchReviewsMock.mockReturnValueOnce(delA.promise).mockReturnValueOnce(delB.promise);

    const { rerender } = renderList();
    await screen.findByRole('status');

    rerender(element({ matchId: OTHER_MATCH_ID }));
    delB.resolve(page([review(2)], null));
    await screen.findByText('Opinión número 2');

    delA.resolve(page([review(1)], null));
    await waitFor(() => expect(listMatchReviewsMock).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('Opinión número 1')).not.toBeInTheDocument();
    expect(listMatchReviewsMock.mock.calls.map(([id]) => id)).toEqual([MATCH_ID, OTHER_MATCH_ID]);
  });

  it('cancela el pedido en vuelo al desmontar', async () => {
    listMatchReviewsMock.mockReturnValue(deferred<ReviewsPage>().promise);

    const { unmount } = renderList();
    await screen.findByRole('status');
    const { signal } = listMatchReviewsMock.mock.calls[0]![2] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it('cancela la página siguiente en vuelo al desmontar', async () => {
    listMatchReviewsMock
      .mockResolvedValueOnce(page([review(2)], 'c1'))
      .mockReturnValueOnce(deferred<ReviewsPage>().promise);

    const { user, unmount } = renderList();
    await screen.findByText('Opinión número 2');
    await user.click(cargarMas());
    await screen.findByText('Cargando más opiniones…');
    const { signal } = listMatchReviewsMock.mock.calls[1]![2] as { signal: AbortSignal };

    unmount();

    expect(signal.aborted).toBe(true);
  });
});
