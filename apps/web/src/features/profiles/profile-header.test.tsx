import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProfileHeader } from './ProfileHeader';
import type { Profile } from './types';

const RIVER = '3f1a2b4c-0000-4000-8000-000000000001';
const equipos = [{ id: RIVER, name: 'River Plate' }];

function renderHeader(profile: Partial<Profile> = {}) {
  return render(
    <ProfileHeader
      profile={{
        displayName: 'Martina',
        bio: 'Hincha de siempre.',
        favoriteTeamId: RIVER,
        ...profile,
      }}
      teams={equipos}
    />,
  );
}

describe('ProfileHeader', () => {
  it('presenta nombre, equipo favorito y biografía en ese orden', () => {
    renderHeader();

    const nombre = screen.getByRole('heading', { level: 2, name: 'Martina' });
    const equipo = screen.getByText('River Plate');
    const bio = screen.getByText('Hincha de siempre.');

    expect(nombre.compareDocumentPosition(equipo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(equipo.compareDocumentPosition(bio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('el equipo se anuncia como favorito sin depender del icono', () => {
    renderHeader();

    expect(screen.getByText('River Plate').closest('p')).toHaveTextContent(
      'Equipo favorito: River Plate',
    );
  });

  it('sin equipo favorito lo dice, sin inventar uno', () => {
    renderHeader({ favoriteTeamId: null });

    expect(screen.getByText('Sin equipo favorito')).toBeInTheDocument();
    expect(screen.queryByText('River Plate')).not.toBeInTheDocument();
  });

  it('un favorito que no está en la lista de equipos se trata como ausente', () => {
    renderHeader({ favoriteTeamId: '3f1a2b4c-0000-4000-8000-000000000099' });

    expect(screen.getByText('Sin equipo favorito')).toBeInTheDocument();
    expect(screen.queryByText(/3f1a2b4c/)).not.toBeInTheDocument();
  });

  it('sin biografía (o solo espacios) lo dice, sin texto de relleno', () => {
    renderHeader({ bio: '   ' });

    expect(screen.getByText('Sin biografía')).toBeInTheDocument();
  });

  it('textos largos se parten en vez de desbordar', () => {
    const nombreLargo = 'M'.repeat(50);
    const bioLarga = `${'palabra '.repeat(30)}${'x'.repeat(60)}`;
    renderHeader({ displayName: nombreLargo, bio: bioLarga });

    expect(screen.getByRole('heading', { name: nombreLargo })).toHaveClass(
      'break-words',
      'min-w-0',
    );
    expect(screen.getByText(bioLarga.trim())).toHaveClass('break-words', 'min-w-0');
  });

  it('no agrega controles: ni avatar editable ni enlaces', () => {
    renderHeader();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
