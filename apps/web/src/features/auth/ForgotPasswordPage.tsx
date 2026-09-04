import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { AuthShell } from './AuthShell';
import { FORGOT_PASSWORD_COPY } from './auth-mode';

const copy = FORGOT_PASSWORD_COPY;

export function ForgotPasswordPage() {
  const emailId = useId();
  const statusId = useId();

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    const { error } = await supabase.auth.resetPasswordForEmail(email);

    setIsSubmitting(false);

    if (error) {
      // El error del proveedor no se muestra: sólo un mensaje presentable.
      setErrorMessage('No pudimos enviar el correo. Intentá de nuevo en unos instantes.');
      return;
    }

    setSent(true);
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
      <form
        className="flex w-full flex-col gap-4"
        onSubmit={handleSubmit}
        aria-busy={isSubmitting}
        aria-describedby={statusId}
      >
        <div className="flex w-full flex-col gap-2">
          <Label htmlFor={emailId}>Correo electrónico</Label>
          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            placeholder={copy.emailPlaceholder}
            required
            value={email}
            disabled={isSubmitting || sent}
            aria-invalid={errorMessage !== null}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div id={statusId} role="status" aria-live="polite" className="empty:hidden">
          {sent ? (
            <p className="rounded-sm border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground">
              {copy.sentMessage}
            </p>
          ) : null}
          {errorMessage !== null ? (
            <p className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </div>

        {sent ? null : (
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
        )}
      </form>
    </AuthShell>
  );
}
