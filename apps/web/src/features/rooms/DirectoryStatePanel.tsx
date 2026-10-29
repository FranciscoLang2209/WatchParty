import type { LucideIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface DirectoryStatePanelProps {
  icon: LucideIcon;
  title: string;
  message: string;
  /** `error` tiñe el icono con el rojo del sistema; el estado igual se lee por icono y texto. */
  tone?: 'neutral' | 'error';
  /** `status` para la carga, `alert` para los fallos; el vacío es contenido estático. */
  role?: 'status' | 'alert';
  /** El icono gira mientras se carga; con movimiento reducido queda quieto. */
  spin?: boolean;
  /** Control del estado (reintentar, volver a ingresar). */
  action?: ReactNode;
  /** Permite llevar el foco al panel cuando el control que lo tenía desaparece. */
  panelRef?: Ref<HTMLDivElement>;
}

/**
 * Presentación única de la carga, el listado vacío y el fallo del directorio de
 * salas: la misma superficie, la misma jerarquía (icono, título, mensaje, acción)
 * y el mismo espacio, para que cambiar de estado no mueva la pantalla.
 */
export function DirectoryStatePanel({
  icon: Icon,
  title,
  message,
  tone = 'neutral',
  role,
  spin = false,
  action,
  panelRef,
}: DirectoryStatePanelProps) {
  return (
    <div
      ref={panelRef}
      role={role}
      // `tabIndex={-1}` sólo permite recibir el foco por código, no por Tab.
      tabIndex={panelRef ? -1 : undefined}
      className="w-full min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="items-center gap-3 px-4 py-8 text-center sm:py-10">
        <Icon
          aria-hidden="true"
          className={cn(
            'size-8 shrink-0',
            tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
            spin && 'animate-spin motion-reduce:animate-none',
          )}
        />

        <h2 className="min-w-0 font-display text-lg leading-snug font-semibold break-words">
          {title}
        </h2>

        <p className="max-w-md min-w-0 text-sm text-muted-foreground">{message}</p>

        {action ? <div className="mt-1 flex w-full justify-center sm:w-auto">{action}</div> : null}
      </Card>
    </div>
  );
}
