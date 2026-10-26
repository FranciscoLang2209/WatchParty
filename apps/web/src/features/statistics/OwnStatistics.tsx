import { useId } from 'react';
import { Eye, MessageSquare, Star, type LucideIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import type { UserStatistics } from './types';
import { useOwnStatistics } from './useOwnStatistics';

interface OwnStatisticsProps {
  userId: string | null;
  accessToken: string | null;
  /** Reingreso por el flujo de Auth cuando la sesión venció. */
  onSessionExpired: () => void;
}

interface Indicador {
  key: keyof UserStatistics;
  label: string;
  Icon: LucideIcon;
}

const INDICADORES: readonly Indicador[] = [
  { key: 'watchedMatches', label: 'Partidos vistos', Icon: Eye },
  { key: 'ratings', label: 'Calificaciones', Icon: Star },
  { key: 'comments', label: 'Comentarios', Icon: MessageSquare },
];

const formato = new Intl.NumberFormat('es-AR');

/**
 * Resumen de actividad del perfil propio (WAT-233): partidos vistos,
 * calificaciones y comentarios, tal cual los cuenta la Node API.
 *
 * Carga, error y sesión vencida son estados distintos: un fallo nunca se
 * presenta como ceros, y una cuenta sin actividad muestra sus ceros reales.
 * Es independiente del formulario: su carga o su fallo no lo bloquean.
 */
export function OwnStatistics({ userId, accessToken, onSessionExpired }: OwnStatisticsProps) {
  const { state, retry } = useOwnStatistics(userId, accessToken);
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading'}
      className="flex w-full min-w-0 flex-col gap-3"
    >
      <h2 id={titleId} className="font-display text-xl leading-tight font-semibold">
        Tu actividad
      </h2>

      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Cargando tu actividad…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">{state.message}</p>

          {state.expired ? (
            <Button type="button" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={retry}>
              Reintentar
            </Button>
          )}
        </div>
      ) : null}

      {state.status === 'ready' ? (
        // Mobile apila una fila por indicador; desde `sm` quedan en tres columnas.
        <dl className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
          {INDICADORES.map(({ key, label, Icon }) => (
            <Card
              key={key}
              className="min-w-0 flex-row items-center justify-between gap-3 p-4 sm:flex-col sm:items-start sm:justify-start"
            >
              <dt className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 break-words">{label}</span>
              </dt>
              <dd className="shrink-0 font-display text-2xl leading-tight font-semibold tabular-nums">
                {formato.format(state.statistics[key])}
              </dd>
            </Card>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
