import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LandingPage } from './LandingPage';
import { THEME_STORAGE_KEY } from '@/lib/theme';

function renderLanding() {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={['/landing']}>
      <Routes>
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/login" element={<p>ruta: /login</p>} />
        <Route path="/register" element={<p>ruta: /register</p>} />
      </Routes>
    </MemoryRouter>,
  );

  return { user };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = '';
});

afterEach(() => {
  document.documentElement.className = '';
});

describe('LandingPage — contenido', () => {
  it('presenta la propuesta de valor con un único h1', () => {
    renderLanding();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Mirá el partido con tu tribuna' }),
    ).toBeInTheDocument();
  });

  it('explica beneficios y funcionamiento en secciones con nombre propio', () => {
    renderLanding();

    const beneficios = screen.getByRole('region', { name: 'Por qué WatchParty' });
    for (const titulo of [
      'Una sala por partido',
      'Comentarios en tiempo real',
      'Tu equipo primero',
    ]) {
      expect(
        within(beneficios).getByRole('heading', { level: 3, name: titulo }),
      ).toBeInTheDocument();
    }

    const pasos = within(screen.getByRole('region', { name: 'Cómo funciona' })).getAllByRole(
      'listitem',
    );
    expect(pasos).toHaveLength(3);
  });

  it('no anuncia funciones pendientes como disponibles', () => {
    renderLanding();

    const texto = document.body.textContent?.toLowerCase() ?? '';

    for (const pendiente of [
      'calific',
      'estadística',
      'reacci',
      'notificaci',
      'buscador',
      'gratis',
    ]) {
      expect(texto).not.toContain(pendiente);
    }
  });

  it('las imágenes informativas tienen texto alternativo y las decorativas se ocultan', () => {
    renderLanding();

    for (const img of document.querySelectorAll('img')) {
      const decorativa = img.getAttribute('aria-hidden') === 'true';

      if (decorativa) expect(img).toHaveAttribute('alt', '');
      else expect(img.getAttribute('alt')).toBe('Logo de WatchParty');
    }
    expect(screen.getAllByRole('img', { name: 'Logo de WatchParty' })).toHaveLength(2);
  });

  it('alterna las variantes del logo según el tema', () => {
    renderLanding();

    const [claro, oscuro] = screen.getAllByRole('img', { name: 'Logo de WatchParty' });

    expect(claro).toHaveAttribute('src', '/title_logo.png');
    expect(claro?.className).toMatch(/\bdark:hidden\b/);
    expect(oscuro).toHaveAttribute('src', '/title_logo-dark.png');
    expect(oscuro?.className).toMatch(/\bdark:block\b/);
  });
});

describe('LandingPage — CTA', () => {
  it('todos los enlaces apuntan a rutas de Auth existentes', () => {
    renderLanding();

    const destinos = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => href !== '#main-content');

    expect(destinos.length).toBeGreaterThan(0);
    for (const href of destinos) expect(['/login', '/register']).toContain(href);
  });

  it('Crear cuenta lleva al registro', async () => {
    const { user } = renderLanding();

    await user.click(screen.getAllByRole('link', { name: 'Crear cuenta' })[0]!);

    expect(screen.getByText('ruta: /register')).toBeInTheDocument();
  });

  it('Ya tengo cuenta lleva al login', async () => {
    const { user } = renderLanding();

    await user.click(screen.getByRole('link', { name: 'Ya tengo cuenta' }));

    expect(screen.getByText('ruta: /login')).toBeInTheDocument();
  });

  it('Ingresar, en la cabecera, lleva al login', async () => {
    const { user } = renderLanding();

    await user.click(screen.getByRole('link', { name: 'Ingresar' }));

    expect(screen.getByText('ruta: /login')).toBeInTheDocument();
  });
});

describe('LandingPage — teclado y tema', () => {
  it('se recorre con el teclado empezando por el salto al contenido', async () => {
    const { user } = renderLanding();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Activar modo oscuro' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Ingresar' })).toHaveFocus();

    await user.tab();
    expect(screen.getAllByRole('link', { name: 'Crear cuenta' })[0]).toHaveFocus();
  });

  it('el salto al contenido apunta al main enfocable', () => {
    renderLanding();

    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('permite cambiar de tema y persiste la preferencia', async () => {
    const { user } = renderLanding();

    await user.click(screen.getByRole('button', { name: 'Activar modo oscuro' }));

    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
