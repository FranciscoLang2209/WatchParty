import { Search } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_ITEMS,
  isNavigationItemActive,
  navigationItemAccessibleName,
  type NavigationItem,
} from './navigation-items';

const PROXIMAMENTE: NavigationItem = {
  id: 'search',
  label: 'Buscar',
  to: '/search',
  icon: Search,
  available: false,
};

describe('navigation-items', () => {
  it('Buscar está habilitado y apunta a /search', () => {
    const buscar = NAVIGATION_ITEMS.find((item) => item.id === 'search');

    expect(buscar).toMatchObject({ label: 'Buscar', to: '/search', available: true });
  });

  it('un destino disponible se nombra por su label y se activa por la URL', () => {
    const buscar = NAVIGATION_ITEMS.find((item) => item.id === 'search')!;

    expect(navigationItemAccessibleName(buscar)).toBe('Buscar');
    expect(isNavigationItemActive(buscar, '/search')).toBe(true);
    expect(isNavigationItemActive(buscar, '/rooms')).toBe(false);
  });

  it('un destino no disponible lo dice en su nombre y nunca figura activo', () => {
    expect(navigationItemAccessibleName(PROXIMAMENTE)).toBe('Buscar, Próximamente');
    expect(isNavigationItemActive(PROXIMAMENTE, '/search')).toBe(false);
  });
});
