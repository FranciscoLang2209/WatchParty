import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  AUTH_COPY,
  LOGIN_EXTRAS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
  REGISTER_FIELDS,
  type AuthMode,
} from './auth-mode';

export interface AuthCredentials {
  email: string;
  password: string;
  /** Sólo en el registro. Se guarda como metadata del usuario en Supabase. */
  username?: string;
  /** Sólo en el login. Decide si la sesión sobrevive al cierre del navegador. */
  remember?: boolean;
}

interface AuthFormProps {
  mode: AuthMode;
  /**
   * Debe lanzar un `Error` con un mensaje seguro y presentable cuando la
   * operación falla. La contraseña nunca se propaga fuera de este componente.
   */
  onSubmit: (credentials: AuthCredentials) => Promise<void>;
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export function AuthForm({ mode, onSubmit }: AuthFormProps) {
  const copy = AUTH_COPY[mode];
  const isRegister = mode === 'register';

  const usernameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const rememberId = useId();
  const errorId = useId();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Recordar la sesión es el valor por defecto, igual que en el mockup.
  const [remember, setRemember] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const invalid = errorMessage !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) return;

    setErrorMessage(null);

    // La confirmación se resuelve en el cliente: no tiene sentido pedirle al
    // proveedor que valide dos campos que ya sabemos que no coinciden.
    if (isRegister && password !== confirmPassword) {
      setErrorMessage(PASSWORD_MISMATCH_MESSAGE);
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit(isRegister ? { email, password, username } : { email, password, remember });
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
      {isRegister ? (
        <Field id={usernameId} label={REGISTER_FIELDS.usernameLabel}>
          <Input
            id={usernameId}
            name="username"
            type="text"
            autoComplete="username"
            placeholder={REGISTER_FIELDS.usernamePlaceholder}
            required
            value={username}
            disabled={isSubmitting}
            aria-invalid={invalid}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
      ) : null}

      <Field id={emailId} label="Correo electrónico">
        <Input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          placeholder={copy.emailPlaceholder}
          required
          value={email}
          disabled={isSubmitting}
          aria-invalid={invalid}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <Field id={passwordId} label="Contraseña">
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete={copy.passwordAutoComplete}
          placeholder={copy.passwordPlaceholder}
          required
          minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
          value={password}
          disabled={isSubmitting}
          aria-invalid={invalid}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      {isRegister ? (
        <Field id={confirmPasswordId} label={REGISTER_FIELDS.confirmPasswordLabel}>
          <Input
            id={confirmPasswordId}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder={REGISTER_FIELDS.confirmPasswordPlaceholder}
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={confirmPassword}
            disabled={isSubmitting}
            aria-invalid={invalid}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>
      ) : null}

      {isRegister ? null : (
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id={rememberId}
              name="remember"
              checked={remember}
              disabled={isSubmitting}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <Label htmlFor={rememberId} className="cursor-pointer">
              {LOGIN_EXTRAS.rememberLabel}
            </Label>
          </div>

          <Link
            to={LOGIN_EXTRAS.forgotTo}
            className="rounded-sm text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {LOGIN_EXTRAS.forgotLabel}
          </Link>
        </div>
      )}

      <div id={errorId} role="alert" aria-live="assertive" className="empty:hidden">
        {errorMessage !== null ? (
          <p className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" className="w-full font-semibold" disabled={isSubmitting}>
        {isSubmitting ? (
          copy.pendingLabel
        ) : (
          <>
            {copy.submitLabel}
            <ChevronRight aria-hidden="true" />
          </>
        )}
      </Button>
    </form>
  );
}
