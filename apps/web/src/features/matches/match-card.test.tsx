import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MatchCard } from './MatchCard';
import type { Match } from './types';

const partido: Match = {
  id: 'match-1',
  homeTeam: 'River Plate',
  awayTeam: 'Boca Juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
};

function renderCard(match: Match = partido) {
  render(
    <MemoryRouter>
      <MatchCard match={match} />
    </MemoryRouter>,
  );
}

describe('MatchCard', () => {
  it('muestra los equipos, el horario y la etiqueta de estado', () => {
    renderCard();

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'River Plate vs. Boca Juniors',
    );
    expect(screen.getByText(/18:00/)).toBeInTheDocument();
    expect(screen.getByText('Programado')).toBeInTheDocument();
  });

  it('no usa CardTitle: la tarjeta nunca aporta un h1', () => {
    renderCard();

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('enlaza al detalle con el nombre accesible acordado', () => {
    renderCard();

    const enlace = screen.getByRole('link', {
      name: 'Ver partido: River Plate vs. Boca Juniors',
    });

    expect(enlace).toHaveAttribute('href', '/matches/match-1');
  });

  it('preserva el id opaco en la URL', () => {
    renderCard({ ...partido, id: 'abc-123-XYZ_opaco' });

    expect(screen.getByRole('link', { name: /Ver partido/ })).toHaveAttribute(
      'href',
      '/matches/abc-123-XYZ_opaco',
    );
  });

  it('no anida controles dentro de la tarjeta', () => {
    renderCard();

    const enlace = screen.getByRole('link', { name: /Ver partido/ });

    expect(enlace.querySelector('a, button')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('distingue el estado en vivo por color y por texto, no sólo por color', () => {
    renderCard({ ...partido, status: 'live' });

    const etiqueta = screen.getByText('En vivo');

    expect(etiqueta.className).toMatch(/text-live/);
  });

  it('un nombre largo no fuerza desplazamiento horizontal', () => {
    renderCard({
      ...partido,
      homeTeam: 'Club Atlético Central Córdoba de Santiago del Estero',
      awayTeam: 'Asociación Atlética Argentinos Juniors de La Paternal',
    });

    const titulo = screen.getByRole('heading', { level: 2 });

    expect(titulo.className).toMatch(/min-w-0/);
    expect(titulo.className).toMatch(/break-words/);
  });

  it('no muestra resultados, minutos ni contenido social', () => {
    renderCard({ ...partido, status: 'live' });

    expect(screen.queryByText(/\d+\s*-\s*\d+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/'|minuto|comentando|sala/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
