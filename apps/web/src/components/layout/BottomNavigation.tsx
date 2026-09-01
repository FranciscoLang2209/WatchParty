import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  NAVIGATION_ITEMS,
  isNavigationItemActive,
  navigationItemAccessibleName,
  type NavigationItem,
} from './navigation-items';

const ITEM_CLASSES = 'h-auto min-h-11 w-full flex-col gap-1 px-1 py-2 [&_svg]:size-5';

function NavigationItemContent({ item, active }: { item: NavigationItem; active: boolean }) {
  const Icon = item.icon;

  return (
    <>
      <Icon
        aria-hidden="true"
        strokeWidth={active ? 2.5 : 2}
        fill={active ? 'currentColor' : 'none'}
      />
      <span className={cn('text-xs leading-none', active && 'font-semibold')}>{item.label}</span>
    </>
  );
}

/**
 * Navegación inferior del área autenticada, visible sólo bajo 981 px. Desde ahí
 * la navegación principal vive en el Header.
 *
 * Los destinos salen de `navigation-items.ts`: no se declara acá ningún label,
 * ruta, disponibilidad ni icono.
 */
export function BottomNavigation() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Navegación móvil"
      className="fixed inset-x-3 bottom-safe-bottom z-40 grid grid-cols-4 gap-1 rounded-lg border border-border bg-background/85 p-1 backdrop-blur desktop:hidden"
    >
      {NAVIGATION_ITEMS.map((item) => {
        const active = isNavigationItemActive(item, pathname);

        return item.available ? (
          <Button key={item.id} asChild variant="ghost" className={ITEM_CLASSES}>
            <Link
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={active ? 'text-primary' : 'text-muted-foreground'}
            >
              <NavigationItemContent item={item} active={active} />
            </Link>
          </Button>
        ) : (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            aria-disabled="true"
            aria-label={navigationItemAccessibleName(item)}
            className={cn(ITEM_CLASSES, 'text-muted-foreground')}
          >
            <NavigationItemContent item={item} active={false} />
          </Button>
        );
      })}
    </nav>
  );
}
