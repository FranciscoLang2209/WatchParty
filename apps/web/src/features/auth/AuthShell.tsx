import type { ReactNode } from 'react';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { TooltipProvider } from '../../components/ui/tooltip';

interface AuthShellProps {
  eyebrow: string;
  title: string;
  description: string;
  /** El formulario de la pantalla. */
  children: ReactNode;
  /** Línea de cierre: el enlace a la otra pantalla de acceso. */
  footer: ReactNode;
}

/**
 * Marco común de las pantallas públicas de acceso: logo, cambio de tema y
 * encabezado. Lo comparten login, registro y recuperación de contraseña para no
 * repetir la maqueta en cada una.
 */
export function AuthShell({ eyebrow, title, description, children, footer }: AuthShellProps) {
  return (
    <TooltipProvider>
      <div className="relative flex min-h-dvh w-full flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="absolute top-4 right-4 rounded-md border border-border bg-card sm:top-6 sm:right-6">
          <ThemeToggle />
        </div>

        <div className="mx-auto flex w-full max-w-md flex-col gap-8">
          {/* Dos variantes del mismo logo: el azul de la marca se pierde sobre el
              fondo oscuro, así que en ese tema se usa una versión aclarada. La
              clase `dark` del <html> las alterna sin lógica adicional. */}
          <img
            src="/title_logo.png"
            alt="WatchParty"
            width={1600}
            height={1095}
            className="mx-auto h-auto w-56 object-contain sm:w-64 dark:hidden"
          />
          <img
            src="/title_logo-dark.png"
            alt="WatchParty"
            width={1600}
            height={1095}
            className="mx-auto hidden h-auto w-56 object-contain sm:w-64 dark:block"
          />

          <header className="flex flex-col gap-3">
            <p className="text-sm font-semibold tracking-widest text-primary uppercase">
              {eyebrow}
            </p>
            <h1 className="font-display text-4xl leading-tight font-semibold sm:text-5xl">
              {title}
            </h1>
            <p className="text-base text-muted-foreground">{description}</p>
          </header>

          {children}

          <p className="w-full text-center text-sm text-muted-foreground">{footer}</p>
        </div>
      </div>
    </TooltipProvider>
  );
}
