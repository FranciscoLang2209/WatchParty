import { useEffect, useId, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import { formatKickoff, formatKickoffDate, matchStatusLabel } from '../matches/format';
import { MatchResult } from '../matches/MatchResult';
import type { WatchedHistoryItem } from './types';
import { useWatchedHistory } from './useWatchedHistory';

interface WatchedHistoryProps {
  userId: string | null;
  accessToken: string | null;
  /** Reingreso por el flujo de Auth cuando la sesión venció. */
  onSessionExpired: () => void;
}

const MENSAJE_VACIO = 'Todavía no marcaste partidos como vistos.';

/**
 * Un partido del historial, en el orden de lectura del sistema de diseño:
 * estado → equipos → marcador → fecha → acción. El marcador real (WAT-230)
 * queda alineado a la derecha en todas las tarjetas; sin marcador se dice
 * «Sin resultado», nunca un 0–0. El estado del partido es un dato aparte.
 */
function HistoryItem({ item }: { item: WatchedHistoryItem }) {
  const { match, watchedAt } = item;
  const enVivo = match.status === 'live';

  return (
    <Card className="gap-3 p-4">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col items-start gap-2">
          <span
            className={cn(
              'rounded-sm px-2 py-1 text-xs font-semibold',
              // El rojo del sistema se reserva para LIVE; el resto usa el fondo sutil.
              enVivo ? 'bg-live/10 text-live' : 'bg-muted text-muted-foreground',
            )}
          >
            {matchStatusLabel(match.status)}
          </span>

          {/* `min-w-0` y el quiebre de palabra evitan que un nombre largo desborde. */}
          <h3 className="min-w-0 text-base leading-snug font-semibold break-words">
            {match.homeTeam} <span className="text-muted-foreground">vs.</span> {match.awayTeam}
          </h3>
        </div>

        <MatchResult match={match} className="shrink-0 text-right" />
      </div>

      <p className="min-w-0 text-sm text-muted-foreground tabular-nums">
        {formatKickoff(match.kickoffAt)}
      </p>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border pt-2">
        <p className="min-w-0 text-sm text-muted-foreground">
          Visto el {formatKickoffDate(watchedAt)}
        </p>

        {/* Área táctil de 44 px; el texto y la flecha la identifican sin depender del color. */}
        <Link
          to={`/matches/${match.id}`}
          aria-label={`Ver partido: ${match.homeTeam} vs. ${match.awayTeam}`}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-semibold text-primary transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
        >
          Ver partido
          <ChevronRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </Card>
  );
}

/**
 * Historial propio de partidos vistos en el perfil (WAT-219), del más reciente
 * al más antiguo.
 *
 * Carga, vacío, error y sesión vencida son estados distintos: un fallo nunca
 * se presenta como «todavía no marcaste partidos». Es independiente del
 * formulario del perfil: su carga o su fallo no lo bloquean.
 */
export function WatchedHistory({ userId, accessToken, onSessionExpired }: WatchedHistoryProps) {
  const { state, loadMore, retry } = useWatchedHistory(userId, accessToken);
  const titleId = useId();
  const lista = useRef<HTMLUListElement>(null);
  // Posición del primer partido de la página pedida: al llegar recibe el foco,
  // así el teclado no se pierde cuando «Cargar más» desaparece.
  const foco = useRef<number | null>(null);
  const cantidad = state.status === 'ready' ? state.items.length : 0;

  useEffect(() => {
    if (foco.current === null || cantidad <= foco.current) return;

    lista.current?.querySelectorAll('a')[foco.current]?.focus();
    foco.current = null;
  }, [cantidad]);

  function pedirMas() {
    foco.current = cantidad;
    loadMore();
  }

  return (
    <section aria-labelledby={titleId} className="flex w-full min-w-0 flex-col gap-4">
      <h2 id={titleId} className="font-display text-2xl leading-tight font-semibold">
        Partidos vistos
      </h2>

      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Cargando tus partidos vistos…
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

      {state.status === 'ready' && state.items.length === 0 ? (
        // No es un fallo: es alguien que todavía no marcó ninguno.
        <p className="text-sm text-muted-foreground">{MENSAJE_VACIO}</p>
      ) : null}

      {state.status === 'ready' && state.items.length > 0 ? (
        <ul ref={lista} className="flex w-full min-w-0 flex-col gap-3">
          {state.items.map((item) => (
            <li key={item.match.id} className="min-w-0">
              <HistoryItem item={item} />
            </li>
          ))}
        </ul>
      ) : null}

      {state.status === 'ready' && state.more === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.moreError}
        </p>
      ) : null}

      {state.status === 'ready' && state.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-auto sm:self-start"
          onClick={pedirMas}
          // No se usa `disabled`: sacaría el foco del botón mientras carga. El
          // hook ya ignora un segundo pedido.
          aria-disabled={state.more === 'loading'}
          aria-busy={state.more === 'loading'}
        >
          {state.more === 'loading'
            ? 'Cargando más…'
            : state.more === 'error'
              ? 'Reintentar'
              : 'Cargar más partidos'}
        </Button>
      ) : null}
    </section>
  );
}
