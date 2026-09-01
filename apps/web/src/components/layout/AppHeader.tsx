import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell, LogOut } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ThemeToggle } from './ThemeToggle';
import {
  COMING_SOON_LABEL,
  NAVIGATION_ITEMS,
  isNavigationItemActive,
  navigationItemAccessibleName,
} from './navigation-items';

interface AppHeaderProps {
  /** El indicador rojo sólo aparece si se recibe explícitamente `true`. */
  hasUnreadNotifications?: boolean;
}

export function AppHeader({ hasUnreadNotifications = false }: AppHeaderProps) {
  const { pathname } = useLocation();
  const { signOut, isSigningOut } = useAuth();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut() {
    setSignOutError(null);

    // Único flujo de logout de la aplicación: el guard de rutas privadas se
    // encarga de la redirección cuando la sesión pasa a ser nula.
    const { error } = await signOut();

    if (error) setSignOutError(error);
  }

  return (
    <TooltipProvider>
      <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 backdrop-blur">
        <a
          href="#main-content"
          className="sr-only rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground ring-2 ring-ring focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
        >
          Saltar al contenido
        </a>

        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-2 px-4 desktop:h-18 desktop:px-6">
          <Button asChild variant="ghost" className="shrink-0 px-2">
            <Link to="/" aria-label="WatchParty, ir al inicio">
              <img
                src="/logo.png"
                alt=""
                aria-hidden="true"
                className="size-8 object-contain dark:hidden"
              />
              <img
                src="/logo-dark.png"
                alt=""
                aria-hidden="true"
                className="hidden size-8 object-contain dark:block"
              />
              <span className="font-display text-base font-semibold">WatchParty</span>
            </Link>
          </Button>

          <nav
            aria-label="Navegación principal"
            className="hidden min-w-0 items-center gap-1 desktop:flex"
          >
            {NAVIGATION_ITEMS.map((item) =>
              item.available ? (
                <Button key={item.id} asChild variant="ghost">
                  <Link
                    to={item.to}
                    aria-current={isNavigationItemActive(item, pathname) ? 'page' : undefined}
                    className={
                      isNavigationItemActive(item, pathname)
                        ? 'font-semibold text-primary'
                        : undefined
                    }
                  >
                    {item.label}
                  </Link>
                </Button>
              ) : (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-disabled="true"
                      aria-label={navigationItemAccessibleName(item)}
                      className="text-muted-foreground"
                    >
                      {item.label}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{COMING_SOON_LABEL}</TooltipContent>
                </Tooltip>
              ),
            )}
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-disabled="true"
                  aria-label={`Notificaciones, ${COMING_SOON_LABEL}`}
                  className="relative"
                >
                  <Bell aria-hidden="true" />
                  {hasUnreadNotifications ? (
                    <span
                      data-testid="notifications-indicator"
                      aria-hidden="true"
                      className="absolute top-2 right-2 size-2 rounded-full bg-destructive"
                    />
                  ) : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Notificaciones próximamente</TooltipContent>
            </Tooltip>

            <Button
              type="button"
              variant="ghost"
              onClick={handleSignOut}
              disabled={isSigningOut}
              aria-label="Cerrar sesión"
              className="gap-2 px-3"
            >
              <LogOut aria-hidden="true" />
              <span className="hidden desktop:inline">
                {isSigningOut ? 'Cerrando sesión…' : 'Cerrar sesión'}
              </span>
            </Button>
          </div>
        </div>

        <div role="alert" aria-live="assertive" className="empty:hidden">
          {signOutError !== null ? (
            <p className="mx-auto max-w-7xl px-4 pb-2 text-sm text-destructive">{signOutError}</p>
          ) : null}
        </div>
      </header>
    </TooltipProvider>
  );
}
