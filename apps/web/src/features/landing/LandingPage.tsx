import { Link } from 'react-router-dom';
import { MessageCircle, Star, Users, type LucideIcon } from 'lucide-react';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { TooltipProvider } from '@/components/ui/tooltip';

interface Beneficio {
  icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * Sólo funciones que ya existen en la app. Calificaciones, estadísticas,
 * reacciones, búsqueda y notificaciones siguen pendientes: no se anuncian.
 */
const BENEFICIOS: readonly Beneficio[] = [
  {
    icon: Users,
    title: 'Una sala por partido',
    description:
      'Cada partido tiene su sala. Entrás y ya estás con otros hinchas que lo están mirando.',
  },
  {
    icon: MessageCircle,
    title: 'Comentarios en tiempo real',
    description: 'Lo que escribís aparece al instante para toda la sala, sin recargar la página.',
  },
  {
    icon: Star,
    title: 'Tu equipo primero',
    description:
      'Elegí tu equipo favorito en el perfil y su próximo partido aparece destacado al entrar.',
  },
];

const PASOS: readonly string[] = [
  'Creá tu cuenta con tu correo y un nombre de usuario.',
  'Buscá el partido en el inicio o en el directorio de salas y entrá a su sala.',
  'Comentá la jugada mientras se juega y leé lo que dicen los demás.',
];

/**
 * Entrada pública de WatchParty para quien todavía no tiene sesión. No decide
 * cuándo se muestra: eso lo resuelve el enrutamiento de la raíz (WAT-204).
 * Los CTA apuntan a las rutas de Auth que ya existen.
 */
export function LandingPage() {
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh w-full flex-col overflow-x-hidden">
        <a
          href="#main-content"
          className="sr-only rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground ring-2 ring-ring focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
        >
          Saltar al contenido
        </a>

        <header className="w-full border-b border-border">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-2 px-4 desktop:h-18 desktop:px-6">
            <div className="flex min-w-0 items-center gap-2 px-2">
              <img
                src="/logo.png"
                alt=""
                aria-hidden="true"
                className="size-8 shrink-0 object-contain dark:hidden"
              />
              <img
                src="/logo-dark.png"
                alt=""
                aria-hidden="true"
                className="hidden size-8 shrink-0 object-contain dark:block"
              />
              <span className="font-display text-base font-semibold">WatchParty</span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ThemeToggle />
              <Button asChild variant="ghost" className="px-3">
                <Link to="/login">Ingresar</Link>
              </Button>
            </div>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex w-full flex-1 flex-col outline-none">
          <section
            aria-labelledby="landing-title"
            className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-12 sm:py-16 desktop:grid-cols-2 desktop:px-6 desktop:py-24"
          >
            <div className="flex flex-col gap-6">
              <p className="text-sm font-semibold tracking-widest text-foreground uppercase dark:text-primary">
                Fútbol en vivo, en comunidad
              </p>
              <h1
                id="landing-title"
                className="font-display text-4xl leading-tight font-semibold sm:text-5xl desktop:text-6xl"
              >
                Mirá el partido con tu tribuna
              </h1>
              <p className="max-w-xl text-lg text-muted-foreground">
                WatchParty junta a los hinchas en una sala por partido para comentar cada jugada en
                tiempo real, estés donde estés.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild size="lg">
                  <Link to="/register">Crear cuenta</Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link to="/login">Ya tengo cuenta</Link>
                </Button>
              </div>
            </div>

            {/* Dos variantes del mismo logo: el azul de la marca se pierde sobre
                el fondo oscuro. La clase `dark` del <html> las alterna. */}
            <div className="flex justify-center">
              <img
                src="/title_logo.png"
                alt="Logo de WatchParty"
                width={1600}
                height={1095}
                className="h-auto w-full max-w-xs object-contain sm:max-w-sm desktop:max-w-md dark:hidden"
              />
              <img
                src="/title_logo-dark.png"
                alt="Logo de WatchParty"
                width={1600}
                height={1095}
                className="hidden h-auto w-full max-w-xs object-contain sm:max-w-sm desktop:max-w-md dark:block"
              />
            </div>
          </section>

          <section
            aria-labelledby="landing-beneficios"
            className="w-full bg-muted/60 py-12 sm:py-16"
          >
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 desktop:px-6">
              <h2
                id="landing-beneficios"
                className="font-display text-3xl leading-tight font-semibold"
              >
                Por qué WatchParty
              </h2>
              <ul className="grid gap-4 sm:grid-cols-3">
                {BENEFICIOS.map(({ icon: Icon, title, description }) => (
                  <li key={title} className="flex">
                    <Card>
                      <CardHeader className="pb-6">
                        <Icon aria-hidden="true" className="mb-2 size-6 text-primary" />
                        {/* `CardTitle` es un h1: acá la jerarquía pide un h3. */}
                        <h3 className="text-xl leading-tight font-semibold">{title}</h3>
                        <CardDescription className="text-base">{description}</CardDescription>
                      </CardHeader>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section
            aria-labelledby="landing-como-funciona"
            className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-12 sm:py-16 desktop:px-6"
          >
            <h2
              id="landing-como-funciona"
              className="font-display text-3xl leading-tight font-semibold"
            >
              Cómo funciona
            </h2>
            <ol className="grid gap-6 sm:grid-cols-3">
              {PASOS.map((paso, index) => (
                <li key={paso} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary font-display text-lg font-semibold text-primary-foreground"
                  >
                    {index + 1}
                  </span>
                  <p className="pt-2 text-base">{paso}</p>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="landing-cta" className="w-full bg-secondary py-12 sm:py-16">
            <div className="mx-auto flex w-full max-w-7xl flex-col items-start gap-6 px-4 text-secondary-foreground desktop:px-6">
              <h2 id="landing-cta" className="font-display text-3xl leading-tight font-semibold">
                El próximo partido se mira acompañado
              </h2>
              <Button asChild size="lg">
                <Link to="/register">Crear cuenta</Link>
              </Button>
            </div>
          </section>
        </main>
      </div>
    </TooltipProvider>
  );
}
