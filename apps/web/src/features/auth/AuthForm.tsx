import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { AUTH_COPY, type AuthMode } from './auth-mode';

export interface AuthCredentials {
  email: string;
  password: string;
}

interface AuthFormProps {
  mode: AuthMode;
  /**
   * Debe lanzar un `Error` con un mensaje seguro y presentable cuando la
   * operación falla. La contraseña nunca se propaga fuera de este componente.
   */
  onSubmit: (credentials: AuthCredentials) => Promise<void>;
}

export function AuthForm({ mode, onSubmit }: AuthFormProps) {
  const copy = AUTH_COPY[mode];
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await onSubmit({ email, password });
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message
          ? error.message
          : 'No pudimos completar la operación. Intentá de nuevo.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      className="flex w-full flex-col gap-4"
      onSubmit={handleSubmit}
      aria-busy={isSubmitting}
      aria-describedby={errorId}
    >
      <div className="flex w-full flex-col gap-2">
        <Label htmlFor={emailId}>Email</Label>
        <Input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={isSubmitting}
          aria-invalid={errorMessage !== null}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      <div className="flex w-full flex-col gap-2">
        <Label htmlFor={passwordId}>Contraseña</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete={copy.passwordAutoComplete}
          required
          value={password}
          disabled={isSubmitting}
          aria-invalid={errorMessage !== null}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div id={errorId} role="alert" aria-live="assertive" className="empty:hidden">
        {errorMessage !== null ? (
          <p className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? copy.pendingLabel : copy.submitLabel}
      </Button>
    </form>
  );
}
