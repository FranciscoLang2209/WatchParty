import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchedHistory } from './WatchedHistory';
import type { WatchedHistoryItem } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const USER = 'user-1';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const fetchMock = vi.fn();
const onSessionExpired = vi.fn();

function item(
  n: number,
  status = 'finished',
  score: WatchedHistoryItem['match']['score'] = null,
): WatchedHistoryItem {
  return {
    match: {
      id: `a${n}111111-1111-4111-8111-111111111111`,
      homeTeam: `Local ${n}`,
      homeTeamId: `h${n}`,
      awayTeam: `Visitante ${n}`,
      awayTeamId: `v${n}`,
      kickoffAt: '2026-10-10T21:00:00Z',
      status: status as WatchedHistoryItem['match']['status'],
      score,
    },
    watchedAt: `2026-10-${String(20 - n).padStart(2, '0')}T15:00:00.000Z`,
    rating: null,
  };
}

function cursor(n: number) {
  return { watchedAt: item(n).watchedAt, matchId: item(n).match.id };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function page(items: WatchedHistoryItem[], nextCursor: unknown = null) {
  return Promise.resolve(jsonResponse({ items, nextCursor }));
}

function failure(status: number, code: string) {
  return Promise.resolve(jsonResponse({ error: { code, message: 'x' } }, status));
}

const BOCA = { id: '0a000000-0000-4000-8000-000000000001', name: 'Boca Juniors' };
const RIVER = { id: '0a000000-0000-4000-8000-000000000002', name: 'River Plate' };

function renderHistory(teams = [BOCA, RIVER]) {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={['/profile']}>
      <Routes>
        <Route
          path="/profile"
          element={
            <WatchedHistory
              userId={USER}
              accessToken={TOKEN}
              teams={teams}
              onSessionExpired={onSessionExpired}
            />
          }
        />
        <Route path="/matches/:matchId" element={<p>Detalle del partido</p>} />
      </Routes>
    </MemoryRouter>,
  );

  return { user };
}

/** Títulos de los partidos en el orden en que se muestran. */
function titulos(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');
}

const cargarMas = () => screen.getByRole('button', { name: 'Cargar más partidos' });
const selectorEquipo = () => screen.getByRole('combobox', { name: 'Filtrar por equipo' });
const selectorNota = () => screen.getByRole('combobox', { name: 'Filtrar por nota' });
const limpiar = () => screen.queryByRole('button', { name: 'Limpiar filtros' });

/** Parámetros de búsqueda del pedido número `n` (desde 0). */
function pedido(n: number): URLSearchParams {
  return new URL(String(fetchMock.mock.calls[n]![0])).searchParams;
}

function conNota(n: number, rating: number): WatchedHistoryItem {
  return { ...item(n), rating };
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

describe('WatchedHistory: estados', () => {
  it('anuncia la carga', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderHistory();

    expect(screen.getByRole('status')).toHaveTextContent('Cargando tus partidos vistos…');
  });

  it('muestra los vistos en el orden del servidor, con fecha, estado y visto el', async () => {
    fetchMock.mockReturnValueOnce(page([item(1), item(2, 'postponed')]));
    renderHistory();

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    expect(titulos()).toEqual(['Local 1 vs. Visitante 1', 'Local 2 vs. Visitante 2']);

    const [primero, segundo] = screen.getAllByRole('listitem');
    expect(within(primero!).getByText('Finalizado')).toBeInTheDocument();
    expect(within(primero!).getByText(/sáb.*10.*oct.*18:00/)).toBeInTheDocument();
    expect(within(primero!).getByText(/^Visto el .*19.*oct/)).toBeInTheDocument();
    expect(within(segundo!).getByText('Postergado')).toBeInTheDocument();
  });

  it('ordena cada tarjeta como estado → equipos → marcador → fecha → acción', async () => {
    fetchMock.mockReturnValueOnce(page([item(1, 'finished', { home: 2, away: 1 })]));
    renderHistory();

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    const tarjeta = screen.getByRole('listitem');
    const enOrden = [
      within(tarjeta).getByText('Finalizado'),
      within(tarjeta).getByRole('heading', { level: 3 }),
      within(tarjeta).getByText('2 – 1'),
      within(tarjeta).getByText(/sáb.*10.*oct.*18:00/),
      within(tarjeta).getByText(/^Visto el /),
      within(tarjeta).getByText('Sin calificar'),
      within(tarjeta).getByRole('link'),
    ];

    for (let i = 1; i < enOrden.length; i += 1) {
      expect(
        enOrden[i - 1]!.compareDocumentPosition(enOrden[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('el enlace al detalle muestra texto y flecha, y su nombre accesible no incluye el icono', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)]));
    renderHistory();

    const enlace = await screen.findByRole('link', {
      name: 'Ver partido: Local 1 vs. Visitante 1',
    });

    expect(enlace).toHaveTextContent('Ver partido');
    expect(enlace.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(enlace).toHaveClass('min-h-11');
  });

  it('muestra el marcador real cuando existe y «Sin resultado» cuando no, sin inventar 0–0', async () => {
    fetchMock.mockReturnValueOnce(
      page([
        item(1, 'finished', { home: 3, away: 1 }),
        item(2, 'finished', { home: 0, away: 0 }),
        item(3, 'postponed'),
      ]),
    );
    renderHistory();

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    const [conGoles, ceroCero, sinResultado] = screen.getAllByRole('listitem');

    expect(within(conGoles!).getByText('3 – 1')).toBeInTheDocument();
    expect(within(conGoles!).getByText('Resultado: Local 1 3, Visitante 1 1')).toBeInTheDocument();
    expect(within(conGoles!).getByText('Finalizado')).toBeInTheDocument();
    expect(within(ceroCero!).getByText('0 – 0')).toBeInTheDocument();
    expect(within(sinResultado!).getByText('Sin resultado')).toBeInTheDocument();
    expect(within(sinResultado!).getByText('Postergado')).toBeInTheDocument();
    expect(within(sinResultado!).queryByText(/\d+\s*–\s*\d+/)).not.toBeInTheDocument();
  });

  it('un historial vacío no es un fallo', async () => {
    fetchMock.mockReturnValueOnce(page([]));
    renderHistory();

    expect(
      await screen.findByText('Todavía no marcaste partidos como vistos.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('un fallo se muestra con reintento, y el reintento se recupera', async () => {
    fetchMock
      .mockReturnValueOnce(failure(500, 'INTERNAL_ERROR'))
      .mockReturnValueOnce(page([item(1)]));
    const { user } = renderHistory();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos cargar tu historial. Intentá de nuevo.',
    );
    expect(screen.queryByText('Todavía no marcaste partidos como vistos.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(
      await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('la sesión vencida ofrece reingresar por el flujo de Auth', async () => {
    fetchMock.mockReturnValueOnce(failure(401, 'UNAUTHORIZED'));
    const { user } = renderHistory();

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

describe('WatchedHistory: nota propia', () => {
  it('muestra la nota de cada partido y «Sin calificar» cuando no tiene', async () => {
    fetchMock.mockReturnValueOnce(page([conNota(1, 4), item(2), conNota(3, 1)]));
    renderHistory();

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    const [calificado, sinCalificar, notaMinima] = screen.getAllByRole('listitem');

    expect(within(calificado!).getByText('Tu nota: 4 de 5')).toBeInTheDocument();
    expect(within(calificado!).queryByText('Sin calificar')).not.toBeInTheDocument();
    expect(within(sinCalificar!).getByText('Sin calificar')).toBeInTheDocument();
    expect(within(sinCalificar!).queryByText(/^Tu nota/)).not.toBeInTheDocument();
    expect(within(notaMinima!).getByText('Tu nota: 1 de 5')).toBeInTheDocument();
  });

  it('la nota convive con la fecha, el resultado y el enlace al detalle', async () => {
    fetchMock.mockReturnValueOnce(
      page([{ ...item(1, 'finished', { home: 2, away: 1 }), rating: 5 }]),
    );
    renderHistory();

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    const tarjeta = screen.getByRole('listitem');

    expect(within(tarjeta).getByText('Tu nota: 5 de 5')).toBeInTheDocument();
    expect(within(tarjeta).getByText('2 – 1')).toBeInTheDocument();
    expect(within(tarjeta).getByText(/^Visto el .*19.*oct/)).toBeInTheDocument();
    expect(
      within(tarjeta).getByRole('link', { name: 'Ver partido: Local 1 vs. Visitante 1' }),
    ).toBeInTheDocument();
  });

  it('el icono de la nota no entra al nombre accesible', async () => {
    fetchMock.mockReturnValueOnce(page([conNota(1, 3)]));
    renderHistory();

    const nota = await screen.findByText('Tu nota: 3 de 5');

    expect(nota.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('WatchedHistory: filtros', () => {
  it('ofrece los equipos recibidos y las opciones de nota, sin filtrar al entrar', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)]));
    renderHistory();

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    expect(
      within(selectorEquipo())
        .getAllByRole('option')
        .map((opcion) => opcion.textContent),
    ).toEqual(['Todos los equipos', 'Boca Juniors', 'River Plate']);
    expect(
      within(selectorNota())
        .getAllByRole('option')
        .map((opcion) => opcion.textContent),
    ).toEqual(['Todos', 'Con nota', 'Sin nota']);
    expect(pedido(0).has('teamId')).toBe(false);
    expect(pedido(0).has('ratingStatus')).toBe(false);
    expect(limpiar()).not.toBeInTheDocument();
  });

  it('elegir un equipo consulta por su id y reemplaza la lista', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)])).mockReturnValueOnce(page([item(2)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'River Plate');

    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });
    expect(titulos()).toEqual(['Local 2 vs. Visitante 2']);
    expect(pedido(1).get('teamId')).toBe(RIVER.id);
    expect(pedido(1).has('ratingStatus')).toBe(false);
  });

  it.each([
    ['Con nota', 'rated'],
    ['Sin nota', 'unrated'],
  ])('«%s» consulta con ratingStatus=%s', async (opcion, valor) => {
    fetchMock.mockReturnValueOnce(page([item(1)])).mockReturnValueOnce(page([item(2)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorNota(), opcion);

    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });
    expect(pedido(1).get('ratingStatus')).toBe(valor);
    expect(pedido(1).has('teamId')).toBe(false);
  });

  it('combina los dos filtros y los conserva al cargar más', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(page([item(2)]))
      .mockReturnValueOnce(page([conNota(3, 4)], cursor(3)))
      .mockReturnValueOnce(page([conNota(4, 2)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'Boca Juniors');
    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });
    await user.selectOptions(selectorNota(), 'Con nota');
    await screen.findByRole('heading', { name: 'Local 3 vs. Visitante 3' });

    expect(pedido(2).get('teamId')).toBe(BOCA.id);
    expect(pedido(2).get('ratingStatus')).toBe('rated');

    await user.click(cargarMas());
    await screen.findByRole('heading', { name: 'Local 4 vs. Visitante 4' });

    expect(titulos()).toEqual(['Local 3 vs. Visitante 3', 'Local 4 vs. Visitante 4']);
    expect(pedido(3).get('teamId')).toBe(BOCA.id);
    expect(pedido(3).get('ratingStatus')).toBe('rated');
    expect(pedido(3).get('beforeMatchId')).toBe(cursor(3).matchId);
  });

  it('volver a «Todos los equipos» deja de mandar teamId', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(page([item(2)]))
      .mockReturnValueOnce(page([item(3)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'Boca Juniors');
    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });
    await user.selectOptions(selectorEquipo(), 'Todos los equipos');
    await screen.findByRole('heading', { name: 'Local 3 vs. Visitante 3' });

    expect(pedido(2).has('teamId')).toBe(false);
    expect(limpiar()).not.toBeInTheDocument();
  });

  it('«Limpiar filtros» restablece los dos selectores y la consulta', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(page([item(2)]))
      .mockReturnValueOnce(page([item(3)]))
      .mockReturnValueOnce(page([item(4)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'River Plate');
    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });
    await user.selectOptions(selectorNota(), 'Sin nota');
    await screen.findByRole('heading', { name: 'Local 3 vs. Visitante 3' });

    await user.click(limpiar()!);
    await screen.findByRole('heading', { name: 'Local 4 vs. Visitante 4' });

    expect(selectorEquipo()).toHaveValue('');
    expect(selectorNota()).toHaveValue('all');
    expect(pedido(3).has('teamId')).toBe(false);
    expect(pedido(3).has('ratingStatus')).toBe(false);
    expect(limpiar()).not.toBeInTheDocument();
  });

  it('sin coincidencias lo dice distinto que un historial vacío, y se puede limpiar', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(page([]))
      .mockReturnValueOnce(page([item(1)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorNota(), 'Con nota');

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Ningún partido visto coincide con estos filtros.',
    );
    expect(screen.queryByText('Todavía no marcaste partidos como vistos.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(limpiar()!);

    expect(
      await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/coincide con estos filtros/)).not.toBeInTheDocument();
  });

  it('un historial vacío sin filtros no se presenta como filtros sin coincidencias', async () => {
    fetchMock.mockReturnValueOnce(page([]));
    renderHistory();

    await screen.findByText('Todavía no marcaste partidos como vistos.');

    expect(screen.queryByText(/coincide con estos filtros/)).not.toBeInTheDocument();
  });

  it('mientras carga una consulta filtrada los controles siguen disponibles', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)])).mockReturnValueOnce(new Promise(() => {}));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'Boca Juniors');

    expect(screen.getByRole('status')).toHaveTextContent('Cargando tus partidos vistos…');
    expect(selectorEquipo()).toHaveValue(BOCA.id);
    expect(limpiar()).toBeInTheDocument();
  });

  it('un error con filtros los conserva y el reintento repite la misma consulta', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(failure(500, 'INTERNAL_ERROR'))
      .mockReturnValueOnce(page([item(2)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'River Plate');
    await screen.findByRole('alert');
    expect(selectorEquipo()).toHaveValue(RIVER.id);

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });

    expect(pedido(2).get('teamId')).toBe(RIVER.id);
  });

  it('sin equipos disponibles el historial funciona y sólo ofrece «Todos los equipos»', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)]));
    renderHistory([]);

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    expect(
      within(selectorEquipo())
        .getAllByRole('option')
        .map((opcion) => opcion.textContent),
    ).toEqual(['Todos los equipos']);
  });

  it('los controles tienen área táctil de 44 px y se apilan en móvil', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)])).mockReturnValueOnce(page([item(2)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    await user.selectOptions(selectorEquipo(), 'Boca Juniors');
    await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' });

    expect(selectorEquipo()).toHaveClass('h-11', 'w-full', 'min-w-0');
    expect(selectorNota()).toHaveClass('h-11', 'w-full', 'min-w-0');
    expect(limpiar()).toHaveClass('min-h-11');
    expect(screen.getByRole('group', { name: 'Filtrar partidos vistos' })).toHaveClass(
      'grid-cols-1',
      'sm:grid-cols-2',
    );
  });
});

describe('WatchedHistory: paginación', () => {
  it('carga las páginas siguientes sin duplicar y oculta el botón al final', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1), item(2)], cursor(2)))
      .mockReturnValueOnce(page([item(2), item(3)], cursor(3)))
      .mockReturnValueOnce(page([item(4)]));
    const { user } = renderHistory();

    await user.click(await screen.findByRole('button', { name: 'Cargar más partidos' }));
    await screen.findByRole('heading', { name: 'Local 3 vs. Visitante 3' });
    await user.click(cargarMas());
    await screen.findByRole('heading', { name: 'Local 4 vs. Visitante 4' });

    expect(titulos()).toEqual([
      'Local 1 vs. Visitante 1',
      'Local 2 vs. Visitante 2',
      'Local 3 vs. Visitante 3',
      'Local 4 vs. Visitante 4',
    ]);
    expect(screen.queryByRole('button', { name: 'Cargar más partidos' })).not.toBeInTheDocument();

    const segunda = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(segunda.searchParams.get('beforeMatchId')).toBe(cursor(2).matchId);
  });

  it('mientras carga la página siguiente no manda un segundo pedido', async () => {
    let responder!: (response: Response) => void;
    fetchMock
      .mockReturnValueOnce(page([item(1)], cursor(1)))
      .mockReturnValueOnce(new Promise<Response>((resolve) => (responder = resolve)));
    const { user } = renderHistory();

    await user.click(await screen.findByRole('button', { name: 'Cargar más partidos' }));

    const cargando = screen.getByRole('button', { name: 'Cargando más…' });
    expect(cargando).toHaveAttribute('aria-busy', 'true');
    await user.click(cargando);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    responder(jsonResponse({ items: [item(2)], nextCursor: null }));
    expect(
      await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' }),
    ).toBeInTheDocument();
  });

  it('un fallo de la página siguiente conserva la lista y deja reintentar', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)], cursor(1)))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValueOnce(page([item(2)]));
    const { user } = renderHistory();

    await user.click(await screen.findByRole('button', { name: 'Cargar más partidos' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos conectarnos');
    expect(titulos()).toEqual(['Local 1 vs. Visitante 1']);

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(
      await screen.findByRole('heading', { name: 'Local 2 vs. Visitante 2' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('WatchedHistory: navegación y teclado', () => {
  it('cada partido lleva a su detalle', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)]));
    const { user } = renderHistory();

    await user.click(
      await screen.findByRole('link', { name: 'Ver partido: Local 1 vs. Visitante 1' }),
    );

    expect(screen.getByText('Detalle del partido')).toBeInTheDocument();
  });

  it('con teclado, cargar más deja el foco en el primer partido nuevo', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)], cursor(1)))
      .mockReturnValueOnce(page([item(2), item(3)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    selectorNota().focus();
    await user.tab();
    expect(
      screen.getByRole('link', { name: 'Ver partido: Local 1 vs. Visitante 1' }),
    ).toHaveFocus();

    await user.tab();
    expect(cargarMas()).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Ver partido: Local 2 vs. Visitante 2' }),
      ).toHaveFocus(),
    );
  });

  it('los filtros se alcanzan y operan con teclado, antes que los partidos', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)])).mockReturnValueOnce(page([]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.tab();
    expect(selectorEquipo()).toHaveFocus();
    await user.tab();
    expect(selectorNota()).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('link', { name: 'Ver partido: Local 1 vs. Visitante 1' }),
    ).toHaveFocus();

    await user.tab({ shift: true });
    await user.selectOptions(selectorNota(), 'Con nota');

    await screen.findByText(/coincide con estos filtros/);
    expect(pedido(1).get('ratingStatus')).toBe('rated');
    expect(selectorNota()).toHaveFocus();
  });

  it('cambiar un filtro con una página en camino no le quita el foco al selector', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)], cursor(1)))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(page([item(2), item(3), item(4)]));
    const { user } = renderHistory();

    await user.click(await screen.findByRole('button', { name: 'Cargar más partidos' }));
    await user.selectOptions(selectorEquipo(), 'Boca Juniors');

    await screen.findByRole('heading', { name: 'Local 4 vs. Visitante 4' });

    expect(selectorEquipo()).toHaveFocus();
  });

  it('«Limpiar filtros» desaparece y el foco pasa al selector de equipo', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(page([]))
      .mockReturnValueOnce(page([item(1)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorNota(), 'Sin nota');
    await screen.findByText(/coincide con estos filtros/);

    limpiar()!.focus();
    await user.keyboard('{Enter}');

    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });
    expect(limpiar()).not.toBeInTheDocument();
    expect(selectorEquipo()).toHaveFocus();
  });

  it('limpiar con una página en camino deja el foco en el selector de equipo', async () => {
    fetchMock
      .mockReturnValueOnce(page([item(1)]))
      .mockReturnValueOnce(page([item(2)], cursor(2)))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(page([item(3), item(4), item(5)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'River Plate');
    await user.click(await screen.findByRole('button', { name: 'Cargar más partidos' }));
    await user.click(limpiar()!);

    await screen.findByRole('heading', { name: 'Local 5 vs. Visitante 5' });

    expect(selectorEquipo()).toHaveFocus();
  });

  it('con filtros activos, la navegación al detalle sigue funcionando', async () => {
    fetchMock.mockReturnValueOnce(page([item(1)])).mockReturnValueOnce(page([item(2)]));
    const { user } = renderHistory();
    await screen.findByRole('heading', { name: 'Local 1 vs. Visitante 1' });

    await user.selectOptions(selectorEquipo(), 'Boca Juniors');
    await user.click(
      await screen.findByRole('link', { name: 'Ver partido: Local 2 vs. Visitante 2' }),
    );

    expect(screen.getByText('Detalle del partido')).toBeInTheDocument();
  });
});
