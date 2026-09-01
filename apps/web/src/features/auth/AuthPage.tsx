import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { AuthForm, type AuthCredentials } from './AuthForm';
import { AUTH_COPY, type AuthMode } from './auth-mode';
import { MISSING_SESSION_MESSAGE, toPresentableAuthError } from './auth-errors';

interface AuthPageProps {
  mode: AuthMode;
}

export function AuthPage({ mode }: AuthPageProps) {
  const copy = AUTH_COPY[mode];
  const navigate = useNavigate();

  async function handleSubmit({ email, password }: AuthCredentials) {
    const { data, error } =
      mode === 'register'
        ? await supabase.auth.signUp({ email, password })
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
    <div className="flex min-h-dvh w-full flex-col items-center justify-center px-4 py-10 sm:px-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
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

        <Card>
          <CardHeader>
            <CardTitle>{copy.title}</CardTitle>
            <CardDescription>{copy.description}</CardDescription>
          </CardHeader>

          <CardContent>
            <AuthForm mode={mode} onSubmit={handleSubmit} />
          </CardContent>

          <CardFooter>
            <p className="w-full text-center text-sm text-muted-foreground">
              {copy.switchPrompt}{' '}
              <Link
                to={copy.switchTo}
                className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {copy.switchLabel}
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
