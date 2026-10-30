import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MatchSummaryCard } from './MatchSummaryCard';
import type { Match } from './types';

const partido: Match = {
  id: 'match-001',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'finished',
  score: { home: 2, away: 1 },
};

function renderCard(match: Partial<Match> = {}) {
  render(
    <MemoryRouter>
      <MatchSummaryCard match={{ ...partido, ...match }} />
    </MemoryRouter>,
  );
}

describe('MatchSummaryCard', () => {
  it('muestra estado, equipos, marcador y horario local', () => {
    renderCard();

    expect(screen.getByText('Finalizado')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'River Plate vs. Boca Juniors' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Resultado: River Plate 2, Boca Juniors 1')).toBeInTheDocument();
    // 21:00 UTC son las 18:00 en Argentina.
    expect(screen.getByText(/18:00/)).toHaveClass('text-muted-foreground');
  });

  it('sin marcador destaca el horario y no inventa un 0–0 ni «Sin resultado»', () => {
    renderCard({ status: 'scheduled', score: null });

    expect(screen.getByText(/18:00/)).toHaveClass('font-display');
    expect(screen.queryByText(/Resultado:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sin resultado')).not.toBeInTheDocument();
    expect(screen.queryByText(/0 – 0/)).not.toBeInTheDocument();
  });

  it('un 0–0 confirmado por el contrato sí se muestra', () => {
    renderCard({ status: 'live', score: { home: 0, away: 0 } });

    expect(screen.getByText('Resultado: River Plate 0, Boca Juniors 0')).toBeInTheDocument();
  });

  it.each([
    ['live', 'En vivo'],
    ['scheduled', 'Programado'],
    ['finished', 'Finalizado'],
    ['postponed', 'Postergado'],
    ['cancelled', 'Cancelado'],
  ] as const)('el estado %s se comunica con el texto «%s»', (status, etiqueta) => {
    renderCard({ status });

    expect(screen.getByText(etiqueta)).toBeInTheDocument();
  });

  it('sólo LIVE usa el rojo del sistema', () => {
    renderCard({ status: 'live' });
    expect(screen.getByText('En vivo').className).toMatch(/text-live/);
  });

  it('el enlace al detalle es un enlace real con nombre accesible y área táctil', () => {
    renderCard();

    const enlace = screen.getByRole('link', { name: 'Ver partido: River Plate vs. Boca Juniors' });

    expect(enlace).toHaveAttribute('href', '/matches/match-001');
    expect(enlace.className).toMatch(/min-h-11/);
    expect(enlace.className).toMatch(/focus-visible:ring-2/);
  });

  it('los nombres largos cortan línea en vez de desbordar', () => {
    renderCard();

    const titulo = screen.getByRole('heading', { name: 'River Plate vs. Boca Juniors' });

    expect(titulo.className).toMatch(/min-w-0/);
    expect(titulo.className).toMatch(/break-words/);
  });
});
