import { useId } from 'react';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH } from './types';

/** Mensajes de validación por campo. Ausente o `null` significa «sin error». */
export interface ProfileFieldErrors {
  displayName?: string | null;
  bio?: string | null;
}

export interface ProfileFieldsProps {
  displayName: string;
  bio: string;
  onDisplayNameChange: (value: string) => void;
  onBioChange: (value: string) => void;
  /** Lo decide quien lo usa: el componente no valida por su cuenta. */
  errors?: ProfileFieldErrors;
  /** Mientras se guarda, los campos no se editan. */
  disabled?: boolean;
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  placeholder?: string;
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  error,
  required = false,
  disabled = false,
  autoComplete,
  placeholder,
}: FieldProps) {
  const fieldId = useId();
  const errorId = useId();

  const invalid = typeof error === 'string' && error.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <Label htmlFor={fieldId}>{label}</Label>

      <Input
        id={fieldId}
        value={value}
        required={required}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={invalid}
        // Se referencia el mensaje sólo cuando existe: un `aria-describedby`
        // apuntando a la nada no aporta y confunde al lector de pantalla.
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />

      {invalid ? (
        <p
          id={errorId}
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Los dos campos de texto del perfil: nombre visible y biografía.
 *
 * Es un componente controlado y sin opinión propia: recibe los valores, avisa
 * los cambios y muestra los errores que le pasan. No consulta la API ni
 * Supabase, no conoce la sesión, no maneja el equipo favorito (eso es WAT-134)
 * y no declara colores propios: usa los tokens del sistema.
 *
 * Los `maxLength` salen de `types.ts`, que replica los límites del backend
 * (WAT-126): así el navegador corta antes de que el servidor devuelva un 400.
 */
export function ProfileFields({
  displayName,
  bio,
  onDisplayNameChange,
  onBioChange,
  errors,
  disabled = false,
}: ProfileFieldsProps) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <Field
        label="Nombre visible"
        value={displayName}
        onChange={onDisplayNameChange}
        maxLength={DISPLAY_NAME_MAX_LENGTH}
        error={errors?.displayName}
        required
        disabled={disabled}
        autoComplete="nickname"
        placeholder="Cómo querés que te vean"
      />

      <Field
        label="Biografía"
        value={bio}
        onChange={onBioChange}
        maxLength={BIO_MAX_LENGTH}
        error={errors?.bio}
        disabled={disabled}
        autoComplete="off"
        placeholder="Contá algo tuyo (opcional)"
      />
    </div>
  );
}
