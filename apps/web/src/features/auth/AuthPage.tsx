import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { TooltipProvider } from '../../components/ui/tooltip';
import { AuthForm, type AuthCredentials } from './AuthForm';
import { AUTH_COPY, type AuthMode } from './auth-mode';
import { MISSING_SESSION_MESSAGE, toPresentableAuthError } from './auth-errors';

interface AuthPageProps {
  mode: AuthMode;
}

export function AuthPage({ mode }: AuthPageProps) {
  const copy = AUTH_COPY[mode];
  const navigate = useNavigate();

  async function handleSubmit({ email, password, username }: AuthCredentials) {
    const { data, error } =
      mode === 'register'
        ? // El nombre de usuario viaja como metadata del usuario: no requiere
          // tabla propia y queda disponible en la sesión.
          await supabase.auth.signUp({ email, password, options: { data: { username } } })
        : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      throw new Error(toPresentableAuthError(error, mode));
    }

    if (!data.session) {
      throw new Error(MISSING_SESSION_MESSAGE[mode]);
    }

    navigate('/', { replace: true });
  }

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
              {copy.eyebrow}
            </p>
            <h1 className="font-display text-4xl leading-tight font-semibold sm:text-5xl">
              {copy.title}
            </h1>
            {copy.description !== undefined ? (
              <p className="text-base text-muted-foreground">{copy.description}</p>
            ) : null}
          </header>

          <AuthForm mode={mode} onSubmit={handleSubmit} />

          <p className="w-full text-center text-sm text-muted-foreground">
            {copy.switchPrompt}{' '}
            <Link
              to={copy.switchTo}
              className="rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {copy.switchLabel}
            </Link>
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
}
