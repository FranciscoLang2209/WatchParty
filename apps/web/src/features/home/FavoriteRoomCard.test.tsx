import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Match } from '@/features/matches/types';
import { FavoriteRoomCard, type FavoriteRoomCardProps } from './FavoriteRoomCard';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';

vi.mock('@/lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  }),
}));

const partido: Match = {
  id: 'match-1',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'live',
};

const sala = { id: 'room-123', matchId: 'match-1', createdAt: '2026-09-06T20:00:00.000Z' };

const NOMBRE_DE_LA_ACCION = 'Entrar a la sala del partido: River Plate vs. Boca Juniors';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function SalaDestino() {
  const { roomId } = useParams<{ roomId: string }>();
  return <p>Sala destino: {roomId}</p>;
}

function renderCard(props: Partial<FavoriteRoomCardProps> = {}) {
  const user = userEvent.setup();

  const view = render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<FavoriteRoomCard match={partido} accessToken={TOKEN} {...props} />}
        />
        <Route path="/rooms/:roomId" element={<SalaDestino />} />
      </Routes>
    </MemoryRouter>,
  );

  return { user, ...view };
}

function boton() {
  return screen.getByRole('button', { name: NOMBRE_DE_LA_ACCION });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FavoriteRoomCard: contenido', () => {
  it('muestra local, visitante, horario y estado del partido recibido', () => {
    renderCard();

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'River Plate vs. Boca Juniors',
    );
    expect(screen.getByText(/18:00/)).toBeInTheDocument();
    expect(screen.getByText('En vivo')).toBeInTheDocument();
  });

  it('usa la etiqueta de estado del partido recibido', () => {
    renderCard({ match: { ...partido, status: 'scheduled' } });

    expect(screen.getByText('Programado')).toBeInTheDocument();
    expect(screen.queryByText('En vivo')).not.toBeInTheDocument();
  });

  it('la acción de entrada tiene un nombre accesible que identifica el partido', () => {
    renderCard();

    expect(boton()).toBeEnabled();
  });

  it('no aporta un h1 ni consulta nada al montarse', () => {
    renderCard();

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('los nombres largos cortan línea y la acción muestra el foco de teclado', () => {
    renderCard();

    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('min-w-0', 'break-words');
    expect(boton().className).toContain('focus-visible:ring-2');
  });
});

describe('FavoriteRoomCard: entrar a la sala', () => {
  it('pide la sala del partido con bearer y navega a la sala devuelta', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ room: sala }));
    const { user } = renderCard();

    await user.click(boton());

    expect(await screen.findByText('Sala destino: room-123')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${API_BASE}/matches/match-1/room`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('no navega hasta que el servidor responde, y no admite un segundo pedido', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { user } = renderCard();

    await user.click(boton());

    expect(boton()).toBeDisabled();
    expect(boton()).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/Sala destino/)).not.toBeInTheDocument();

    await user.click(boton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si falla lo anuncia, no navega y permite volver a intentar', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
    );
    const { user } = renderCard();

    await user.click(boton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos abrir la sala. Intentá de nuevo.',
    );
    expect(screen.queryByText(/Sala destino/)).not.toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse({ room: sala }));
    await user.click(boton());

    expect(await screen.findByText('Sala destino: room-123')).toBeInTheDocument();
  });

  it('con la sesión vencida ofrece reingresar', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401),
    );
    const onSessionExpired = vi.fn();
    const { user } = renderCard({ onSessionExpired });

    await user.click(boton());
    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('cancela el pedido en curso al desmontarse', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { user, unmount } = renderCard();

    await user.click(boton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    unmount();

    expect(init.signal?.aborted).toBe(true);
  });
});
