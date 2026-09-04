import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/**
 * Checkbox sobre el `<input type="checkbox">` nativo: conserva la semántica y el
 * teclado del navegador, y se estila con los tokens del sistema. El tilde es un
 * icono superpuesto porque `appearance-none` quita el glifo del navegador.
 */
function Checkbox({ className, ...props }: ComponentProps<'input'>) {
  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <input
        type="checkbox"
        className={cn(
          'peer size-5 appearance-none rounded-sm border border-input bg-card transition-colors checked:border-primary checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        strokeWidth={3}
        className="pointer-events-none absolute size-4 text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}

export { Checkbox };
