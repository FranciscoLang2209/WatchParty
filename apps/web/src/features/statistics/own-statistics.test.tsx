import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnStatistics } from './OwnStatistics';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';
const USER = 'user-1';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const fetchMock = vi.fn();
const onSessionExpired = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderStatistics() {
  const user = userEvent.setup();

  render(<OwnStatistics userId={USER} accessToken={TOKEN} onSessionExpired={onSessionExpired} />);

  return { user };
}

/** El valor que acompaña a cada indicador en la lista de definición. */
function valorDe(label: string): string | null | undefined {
  return screen.getByText(label).closest('dt')?.nextElementSibling?.textContent;
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

describe('OwnStatistics', () => {
  it('anuncia la carga mientras espera a la API', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    renderStatistics();

    expect(screen.getByRole('status')).toHaveTextContent('Cargando tu actividad…');
    expect(screen.getByRole('region', { name: 'Tu actividad' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('muestra los tres indicadores que devuelve la API', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ statistics: { watchedMatches: 12, ratings: 7, comments: 1234 } }),
    );

    renderStatistics();

    expect(await screen.findByText('Partidos vistos')).toBeInTheDocument();
    expect(valorDe('Partidos vistos')).toBe('12');
    expect(valorDe('Calificaciones')).toBe('7');
    expect(valorDe('Comentarios')).toBe('1.234');
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/me/statistics`, expect.anything());
  });

  it('muestra ceros reales para una cuenta sin actividad', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ statistics: { watchedMatches: 0, ratings: 0, comments: 0 } }),
    );

    renderStatistics();

    await screen.findByText('Partidos vistos');
    expect(valorDe('Partidos vistos')).toBe('0');
    expect(valorDe('Calificaciones')).toBe('0');
    expect(valorDe('Comentarios')).toBe('0');
  });

  it('ante un fallo muestra el error, no ceros, y reintenta', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ statistics: { watchedMatches: 2, ratings: 1, comments: 3 } }),
      );

    const { user } = renderStatistics();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos cargar tu actividad. Intentá de nuevo.',
    );
    expect(screen.queryByText('Partidos vistos')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Partidos vistos')).toBeInTheDocument();
    expect(valorDe('Partidos vistos')).toBe('2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('con la sesión vencida ofrece volver a iniciar sesión', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401));

    const { user } = renderStatistics();

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });
});
