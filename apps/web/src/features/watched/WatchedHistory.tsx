import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { cn } from '../../lib/utils';
import { formatKickoff, formatKickoffDate, matchStatusLabel } from '../matches/format';
import { MatchResult } from '../matches/MatchResult';
import type { TeamOption } from '../profiles/types';
import type {
  WatchedHistoryFilters,
  WatchedHistoryItem,
  WatchedHistoryRatingStatus,
} from './types';
import { useWatchedHistory } from './useWatchedHistory';

interface WatchedHistoryProps {
  userId: string | null;
  accessToken: string | null;
  /** Opciones del filtro por equipo: las que ya consultó el perfil. */
  teams: readonly TeamOption[];
  /** Reingreso por el flujo de Auth cuando la sesión venció. */
  onSessionExpired: () => void;
}

const MENSAJE_VACIO = 'Todavía no marcaste partidos como vistos.';
const MENSAJE_SIN_COINCIDENCIAS = 'Ningún partido visto coincide con estos filtros.';

/** El valor vacío del selector es «todos», que no se envía como filtro. */
const TODOS_LOS_EQUIPOS = '';

const OPCIONES_DE_NOTA: readonly { value: WatchedHistoryRatingStatus; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'rated', label: 'Con nota' },
  { value: 'unrated', label: 'Sin nota' },
];

const CLASE_SELECTOR =
  'flex h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:text-sm';

/** La nota propia; el icono acompaña, pero el dato lo dice el texto. */
function NotaPropia({ rating }: { rating: number | null }) {
  if (rating === null) {
    return <p className="text-sm text-muted-foreground">Sin calificar</p>;
  }

  return (
    <p className="inline-flex items-center gap-1 text-sm font-semibold">
      <Star aria-hidden="true" className="size-4 fill-primary text-primary" />
      Tu nota: {rating} de 5
    </p>
  );
}

/**
 * Un partido del historial, en el orden de lectura del sistema de diseño:
 * estado → equipos → marcador → fecha → acción. El marcador real (WAT-230)
 * queda alineado a la derecha en todas las tarjetas; sin marcador se dice
 * «Sin resultado», nunca un 0–0. El estado del partido es un dato aparte.
 */
function HistoryItem({ item }: { item: WatchedHistoryItem }) {
  const { match, watchedAt, rating } = item;
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
        <div className="flex min-w-0 flex-col items-start gap-1">
          <p className="min-w-0 text-sm text-muted-foreground">
            Visto el {formatKickoffDate(watchedAt)}
          </p>
          <NotaPropia rating={rating} />
        </div>

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
 * Carga, vacío, sin coincidencias, error y sesión vencida son estados
 * distintos: un fallo nunca se presenta como «todavía no marcaste partidos», ni
 * unos filtros sin resultados como un historial vacío. Los filtros (WAT-265)
 * siguen disponibles en todos ellos. Es independiente del formulario del
 * perfil: su carga o su fallo no lo bloquean.
 */
export function WatchedHistory({
  userId,
  accessToken,
  teams,
  onSessionExpired,
}: WatchedHistoryProps) {
  const [filtros, setFiltros] = useState<WatchedHistoryFilters>({});
  const { state, loadMore, retry } = useWatchedHistory(userId, accessToken, filtros);
  const titleId = useId();
  const equipoId = useId();
  const notaId = useId();
  const selectorEquipo = useRef<HTMLSelectElement>(null);
  const lista = useRef<HTMLUListElement>(null);
  // Posición del primer partido de la página pedida: al llegar recibe el foco,
  // así el teclado no se pierde cuando «Cargar más» desaparece.
  const foco = useRef<number | null>(null);
  const cantidad = state.status === 'ready' ? state.items.length : 0;
  const ratingStatus = filtros.ratingStatus ?? 'all';
  const hayFiltros = filtros.teamId !== undefined || ratingStatus !== 'all';

  useEffect(() => {
    if (foco.current === null || cantidad <= foco.current) return;

    lista.current?.querySelectorAll('a')[foco.current]?.focus();
    foco.current = null;
  }, [cantidad]);

  function pedirMas() {
    foco.current = cantidad;
    loadMore();
  }

  // La lista va a cambiar por completo: una página pedida antes ya no llega y el
  // foco se queda en el control que se está usando.
  function filtrar(cambio: WatchedHistoryFilters) {
    foco.current = null;
    setFiltros((actuales) => ({ ...actuales, ...cambio }));
  }

  function limpiarFiltros() {
    foco.current = null;
    setFiltros({});
    // El botón desaparece: sin esto, el teclado volvería al inicio de la página.
    selectorEquipo.current?.focus();
  }

  return (
    <section aria-labelledby={titleId} className="flex w-full min-w-0 flex-col gap-4">
      <h2 id={titleId} className="font-display text-2xl leading-tight font-semibold">
        Partidos vistos
      </h2>

      <div
        role="group"
        aria-label="Filtrar partidos vistos"
        className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={equipoId}>Filtrar por equipo</Label>

          <select
            ref={selectorEquipo}
            id={equipoId}
            className={CLASE_SELECTOR}
            value={filtros.teamId ?? TODOS_LOS_EQUIPOS}
            onChange={(event) =>
              filtrar({
                teamId: event.target.value === TODOS_LOS_EQUIPOS ? undefined : event.target.value,
              })
            }
          >
            <option value={TODOS_LOS_EQUIPOS}>Todos los equipos</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={notaId}>Filtrar por nota</Label>

          <select
            id={notaId}
            className={CLASE_SELECTOR}
            value={ratingStatus}
            onChange={(event) =>
              filtrar({ ratingStatus: event.target.value as WatchedHistoryRatingStatus })
            }
          >
            {OPCIONES_DE_NOTA.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {hayFiltros ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:col-span-2 sm:w-auto sm:justify-self-start"
            onClick={limpiarFiltros}
          >
            Limpiar filtros
          </Button>
        ) : null}
      </div>

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

      {state.status === 'ready' && state.items.length === 0 && !hayFiltros ? (
        // No es un fallo: es alguien que todavía no marcó ninguno.
        <p className="text-sm text-muted-foreground">{MENSAJE_VACIO}</p>
      ) : null}

      {state.status === 'ready' && state.items.length === 0 && hayFiltros ? (
        <p role="status" className="text-sm text-muted-foreground">
          {MENSAJE_SIN_COINCIDENCIAS}
        </p>
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
