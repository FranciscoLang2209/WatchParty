import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('./lib/supabase', () => ({ supabase: { auth: authMock } }));

const { default: App } = await import('./App');

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

describe('App', () => {
  it('monta el provider de sesión y el router, y muestra la landing en la raíz sin sesión', async () => {
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mirá el partido con tu tribuna' }),
    ).toBeInTheDocument();
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
  });
});
