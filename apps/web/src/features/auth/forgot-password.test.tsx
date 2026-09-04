import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthError } from '@supabase/supabase-js';

const { authMock } = vi.hoisted(() => ({
  authMock: { resetPasswordForEmail: vi.fn() },
}));

vi.mock('../../lib/supabase', () => ({ supabase: { auth: authMock } }));

const { ForgotPasswordPage } = await import('./ForgotPasswordPage');

function renderPage() {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/login" element={<h1>Entrá a la tribuna</h1>} />
      </Routes>
    </MemoryRouter>,
  );

  return { user };
}

async function pedirEnlace(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Correo electrónico'), 'persona@watchparty.test');
  await user.click(screen.getByRole('button', { name: 'Enviar enlace' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});

describe('ForgotPasswordPage', () => {
  it('presenta la pantalla con el marco de acceso', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: '¿Olvidaste tu contraseña?' })).toBeInTheDocument();
    expect(screen.getByText('Recuperá tu acceso')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'WatchParty' })).toHaveLength(2);
  });

  it('pide únicamente el correo', () => {
    renderPage();

    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByLabelText('Correo electrónico')).toBeRequired();
    expect(screen.queryByLabelText(/contraseña/i)).not.toBeInTheDocument();
  });

  it('envía el pedido de recuperación al correo ingresado', async () => {
    const { user } = renderPage();

    await pedirEnlace(user);

    expect(authMock.resetPasswordForEmail).toHaveBeenCalledWith('persona@watchparty.test');
  });

  it('confirma sin revelar si la cuenta existe', async () => {
    const { user } = renderPage();

    await pedirEnlace(user);

    const status = await screen.findByRole('status');

    expect(status).toHaveTextContent('Si existe una cuenta con ese correo');
    // No confirma ni desmiente: evita que se puedan averiguar correos registrados.
    expect(status).not.toHaveTextContent('persona@watchparty.test');
  });

  it('oculta el botón una vez enviado, para no reenviar por error', async () => {
    const { user } = renderPage();

    await pedirEnlace(user);
    await screen.findByRole('status');

    expect(screen.queryByRole('button', { name: 'Enviar enlace' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toBeDisabled();
  });

  it('comunica el estado pendiente', async () => {
    authMock.resetPasswordForEmail.mockReturnValue(new Promise(() => {}));

    const { user } = renderPage();
    await pedirEnlace(user);

    const form = screen.getByRole('button', { name: 'Enviando…' }).closest('form');

    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Enviando…' })).toBeDisabled();
  });

  it('no expone el error interno del proveedor', async () => {
    authMock.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: {
        name: 'AuthApiError',
        message: 'SMTP relay failed at /auth/v1/recover',
        code: 'unexpected_failure',
        status: 500,
      } as AuthError,
    });

    const { user } = renderPage();
    await pedirEnlace(user);

    const status = await screen.findByRole('status');

    expect(status).toHaveTextContent('No pudimos enviar el correo.');
    expect(status).not.toHaveTextContent('/auth/v1/recover');
    expect(status).not.toHaveTextContent('SMTP');
    // Se puede reintentar.
    expect(screen.getByRole('button', { name: 'Enviar enlace' })).toBeEnabled();
  });

  it('permite volver al login', async () => {
    const { user } = renderPage();

    await user.click(screen.getByRole('link', { name: 'Ingresar' }));

    expect(await screen.findByRole('heading', { name: 'Entrá a la tribuna' })).toBeInTheDocument();
  });
});
