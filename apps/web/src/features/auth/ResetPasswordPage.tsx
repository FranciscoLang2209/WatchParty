import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../auth/useAuth';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { AuthShell } from './AuthShell';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
  RESET_PASSWORD_COPY,
  SHORT_PASSWORD_MESSAGE,
} from './auth-mode';

const copy = RESET_PASSWORD_COPY;

/**
 * Cambio de contraseña al volver del enlace del correo.
 *
 * La autorización no viene de tener sesión sino de la señal `PASSWORD_RECOVERY`
 * que el AuthProvider registra: sin ella, la pantalla no ofrece el formulario.
 * Al terminar se cierra esa sesión para que el enlace no quede reutilizable.
 */
export function ResetPasswordPage() {
  const { status, session, isRecovering, endRecovery, signOut } = useAuth();
  const navigate = useNavigate();

  const passwordId = useId();
  const confirmId = useId();
  const errorId = useId();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canChangePassword = isRecovering && session !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) return;

    setErrorMessage(null);

    // Las dos validaciones se resuelven acá: no tiene sentido gastar un viaje
    // al proveedor por algo que ya sabemos que va a rechazar.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(SHORT_PASSWORD_MESSAGE);
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage(PASSWORD_MISMATCH_MESSAGE);
      return;
    }

    setIsSubmitting(true);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setIsSubmitting(false);
      setErrorMessage(copy.failureMessage);
      return;
    }

    // La sesión de recuperación muere con el cambio: se apaga el modo, se cierra
    // la sesión y se vuelve a entrar con la contraseña nueva.
    endRecovery();
    await signOut();

    void navigate(copy.backTo, { replace: true });
  }

  return (
    <AuthShell
      eyebrow={copy.eyebrow}
      title={copy.title}
      description={copy.description}
      footer={
        <>
          {copy.backPrompt}{' '}
          <Link
            to={copy.backTo}
            className="rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {copy.backLabel}
          </Link>
        </>
      }
    >
      {status === 'loading' ? (
        // Mientras Supabase resuelve el enlace no se puede afirmar que sea
        // inválido: decirlo antes de tiempo asustaría sin motivo.
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {copy.checkingMessage}
        </p>
      ) : null}

      {status !== 'loading' && !canChangePassword ? (
        <div className="flex w-full flex-col items-start gap-4">
          <p
            role="alert"
            className="w-full rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {copy.invalidMessage}
          </p>

          <Button asChild size="lg" className="w-full font-semibold">
            <Link to={copy.requestTo}>
              {copy.requestLabel}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      ) : null}

      {canChangePassword ? (
        <form
          className="flex w-full flex-col gap-4"
          onSubmit={handleSubmit}
          aria-busy={isSubmitting}
          aria-describedby={errorId}
        >
          <div className="flex w-full flex-col gap-2">
            <Label htmlFor={passwordId}>{copy.passwordLabel}</Label>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={copy.passwordPlaceholder}
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              disabled={isSubmitting}
              aria-invalid={errorMessage !== null}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <div className="flex w-full flex-col gap-2">
            <Label htmlFor={confirmId}>{copy.confirmLabel}</Label>
            <Input
              id={confirmId}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder={copy.confirmPlaceholder}
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={confirmPassword}
              disabled={isSubmitting}
              aria-invalid={errorMessage !== null}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>

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
      ) : null}
    </AuthShell>
  );
}
