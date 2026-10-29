import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MatchCard } from './MatchCard';
import type { Match } from './types';

const partido: Match = {
  id: 'match-1',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
  score: null,
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

  it('el título baja a h3 cuando la tarjeta cuelga de un título de sección', () => {
    render(
      <MemoryRouter>
        <MatchCard match={partido} headingLevel="h3" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
      'River Plate vs. Boca Juniors',
    );
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
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
      homeTeamId: 'team-central-cordoba',
      awayTeam: 'Asociación Atlética Argentinos Juniors de La Paternal',
      awayTeamId: 'team-argentinos-juniors',
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

describe('MatchCard — variante del directorio', () => {
  function renderDirectorio(match: Match = partido) {
    render(
      <MemoryRouter>
        <MatchCard match={match} variant="directory" />
      </MemoryRouter>,
    );
  }

  it('lee en el orden del sistema de diseño: estado, equipos, horario y acción', () => {
    renderDirectorio();

    const estado = screen.getByText('Programado');
    const equipos = screen.getByRole('heading', { level: 2 });
    const horario = screen.getByText(/18:00/);
    const accion = screen.getByRole('link', { name: /Ver partido/ });

    expect(estado.compareDocumentPosition(equipos)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(equipos.compareDocumentPosition(horario)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(horario.compareDocumentPosition(accion)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('conserva los datos reales y el enlace existente al detalle, con el mismo nombre accesible', () => {
    renderDirectorio({ ...partido, id: 'abc-123-XYZ_opaco' });

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'River Plate vs. Boca Juniors',
    );
    expect(
      screen.getByRole('link', { name: 'Ver partido: River Plate vs. Boca Juniors' }),
    ).toHaveAttribute('href', '/matches/abc-123-XYZ_opaco');
  });

  it('el enlace se reconoce como acción: ocupa el ancho, mide 44 px y lleva un icono decorativo', () => {
    renderDirectorio();

    const enlace = screen.getByRole('link', { name: /Ver partido/ });

    expect(enlace).toHaveClass('h-11', 'w-full', 'border');
    expect(enlace.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(enlace).toHaveTextContent('Ver partido');
  });

  it('no agrega botones ni controles inertes: la única acción es el enlace', () => {
    renderDirectorio();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link').querySelector('a, button')).toBeNull();
  });

  it('distingue el estado en vivo por color y por texto, no sólo por color', () => {
    renderDirectorio({ ...partido, status: 'live' });

    expect(screen.getByText('En vivo').className).toMatch(/text-live/);
  });

  it('un nombre largo no fuerza desplazamiento horizontal', () => {
    renderDirectorio({
      ...partido,
      homeTeam: 'Club Atlético Central Córdoba de Santiago del Estero',
      homeTeamId: 'team-central-cordoba',
      awayTeam: 'Asociación Atlética Argentinos Juniors de La Paternal',
      awayTeamId: 'team-argentinos-juniors',
    });

    const titulo = screen.getByRole('heading', { level: 2 });

    expect(titulo).toHaveClass('min-w-0', 'break-words');
  });

  it('no inventa datos: sin resultados, minutos ni contenido social', () => {
    renderDirectorio({ ...partido, status: 'live' });

    expect(screen.queryByText(/\d+\s*-\s*\d+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/'|minuto|comentando|sala/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('la variante por defecto no cambia: el enlace sigue siendo de texto y el horario va antes del estado', () => {
    renderCard();

    const enlace = screen.getByRole('link', { name: /Ver partido/ });

    expect(enlace).not.toHaveClass('h-11');
    expect(enlace.querySelector('svg')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveClass('font-display');
    expect(screen.getByText(/18:00/).compareDocumentPosition(screen.getByText('Programado'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
