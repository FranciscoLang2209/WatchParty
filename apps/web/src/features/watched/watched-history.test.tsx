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

function renderHistory() {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={['/profile']}>
      <Routes>
        <Route
          path="/profile"
          element={
            <WatchedHistory userId={USER} accessToken={TOKEN} onSessionExpired={onSessionExpired} />
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
});
