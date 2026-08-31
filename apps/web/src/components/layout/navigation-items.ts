import { Home, Search, User, Users, type LucideIcon } from 'lucide-react';

export type NavigationItemId = 'home' | 'rooms' | 'search' | 'profile';

export interface NavigationItem {
  id: NavigationItemId;
  label: string;
  to: string;
  icon: LucideIcon;
  /** Cuando la ruta se implemente, alcanza con poner `true` acá. */
  available: boolean;
}

/**
 * Única configuración de navegación del producto. La comparten el Header y la
 * navegación inferior: no volver a declarar labels, rutas, disponibilidad ni
 * iconos en ningún otro lugar.
 */
export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { id: 'home', label: 'Inicio', to: '/', icon: Home, available: true },
  { id: 'rooms', label: 'Salas', to: '/rooms', icon: Users, available: false },
  { id: 'search', label: 'Buscar', to: '/search', icon: Search, available: false },
  { id: 'profile', label: 'Perfil', to: '/profile', icon: User, available: false },
];

export const COMING_SOON_LABEL = 'Próximamente';

/** Los destinos aún no disponibles lo comunican en su nombre accesible. */
export function navigationItemAccessibleName(item: NavigationItem): string {
  return item.available ? item.label : `${item.label}, ${COMING_SOON_LABEL}`;
}

/** El destino activo se deriva de la URL, nunca de un estado paralelo. */
export function isNavigationItemActive(item: NavigationItem, pathname: string): boolean {
  if (!item.available) return false;

  return item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
}
