import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getHistoricalDetail } from './api';
import {
  NO_DATA,
  formatFetchedDate,
  formatGoalMinute,
  formatMetric,
  formatPossession,
  goalKindLabel,
  goalPlayer,
  latestFetchedAt,
  spokenGoalMinute,
} from './historical-format';
import {
  MatchesApiError,
  isCancelled,
  type GoalEntry,
  type HistoricalDetail,
  type HistoricalGoals,
  type HistoricalStatistics,
  type Match,
} from './types';

interface MatchHistoricalDetailProps {
  match: Pick<Match, 'id' | 'homeTeam' | 'awayTeam'>;
  accessToken: string | null;
  onSessionExpired: () => void;
}

type Lectura =
  | { status: 'loading' }
  | { status: 'ready'; detail: HistoricalDetail | null }
  | { status: 'error'; message: string; expired: boolean };

const MENSAJE_LECTURA = 'No pudimos cargar las estadísticas y los goles. Intentá de nuevo.';

function toError(error: unknown): Lectura {
  if (error instanceof MatchesApiError) {
    // El texto genérico del cliente habla de «partidos»: acá el fallo es de esta sección, y el
    // resto del detalle sigue funcionando. Sólo se conserva el aviso de falta de conexión.
    return {
      status: 'error',
      message: error.kind === 'network' ? error.message : MENSAJE_LECTURA,
      expired: error.kind === 'unauthorized',
    };
  }

  return { status: 'error', message: MENSAJE_LECTURA, expired: false };
}

interface MetricRow {
  label: string;
  home: string;
  away: string;
}

function statisticRows(statistics: HistoricalStatistics): MetricRow[] {
  const { home, away } = statistics;

  return [
    {
      label: 'Posesión',
      home: formatPossession(home.possessionPct),
      away: formatPossession(away.possessionPct),
    },
    { label: 'Remates', home: formatMetric(home.totalShots), away: formatMetric(away.totalShots) },
    {
      label: 'Remates al arco',
      home: formatMetric(home.shotsOnGoal),
      away: formatMetric(away.shotsOnGoal),
    },
    {
      label: 'Córners',
      home: formatMetric(home.cornerKicks),
      away: formatMetric(away.cornerKicks),
    },
    { label: 'Faltas', home: formatMetric(home.fouls), away: formatMetric(away.fouls) },
  ];
}

function Value({ text, align }: { text: string; align: 'left' | 'right' }) {
  const sinDato = text === NO_DATA;

  return (
    <td
      className={`px-2 py-2 tabular-nums ${align === 'left' ? 'text-left' : 'text-right'} ${
        sinDato ? 'text-muted-foreground italic' : 'font-semibold'
      }`}
    >
      {text}
    </td>
  );
}

function Estadisticas({
  statistics,
  homeTeam,
  awayTeam,
}: {
  statistics: HistoricalStatistics | null;
  homeTeam: string;
  awayTeam: string;
}) {
  const tituloId = useId();

  if (statistics === null) {
    return (
      <section aria-labelledby={tituloId} className="flex flex-col gap-2">
        <h3 id={tituloId} className="text-sm font-semibold">
          Estadísticas
        </h3>
        <p className="text-sm text-muted-foreground">
          {NO_DATA}: todavía no se cargaron las estadísticas de este partido.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby={tituloId} className="flex flex-col gap-2">
      <h3 id={tituloId} className="text-sm font-semibold">
        Estadísticas
      </h3>

      {statistics.coverage === 'partial' ? (
        <p role="note" className="text-sm text-muted-foreground">
          Cobertura restringida: el proveedor no informó todas las métricas. Las que faltan figuran
          como «{NO_DATA}», no como cero.
        </p>
      ) : null}

      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">
          Estadísticas del partido: {homeTeam} contra {awayTeam}
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="w-2/5 px-2 py-2 text-left font-semibold break-words">
              {homeTeam}
            </th>
            <th scope="col" className="w-1/5 px-2 py-2 text-center">
              <span className="sr-only">Métrica</span>
            </th>
            <th scope="col" className="w-2/5 px-2 py-2 text-right font-semibold break-words">
              {awayTeam}
            </th>
          </tr>
        </thead>
        <tbody>
          {statisticRows(statistics).map((row) => (
            <tr key={row.label} className="border-b border-border/60 last:border-0">
              <Value text={row.home} align="left" />
              <th
                scope="row"
                className="px-2 py-2 text-center text-xs font-normal text-muted-foreground"
              >
                {row.label}
              </th>
              <Value text={row.away} align="right" />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function GoalList({
  titulo,
  nota,
  entries,
  homeTeam,
  awayTeam,
}: {
  titulo: string;
  nota?: string;
  entries: GoalEntry[];
  homeTeam: string;
  awayTeam: string;
}) {
  const tituloId = useId();

  return (
    <div className="flex flex-col gap-1">
      <h4 id={tituloId} className="text-sm font-medium">
        {titulo}
      </h4>
      {nota ? <p className="text-xs text-muted-foreground">{nota}</p> : null}

      <ol aria-labelledby={tituloId} className="flex flex-col gap-1">
        {entries.map((entry, index) => {
          const etiqueta = goalKindLabel(entry.kind);

          return (
            <li
              key={`${entry.minute}-${entry.extraMinute}-${index}`}
              className="flex gap-2 text-sm"
            >
              <span className="w-14 shrink-0 font-semibold tabular-nums">
                <span aria-hidden="true">{formatGoalMinute(entry.minute, entry.extraMinute)}</span>
                <span className="sr-only">
                  {spokenGoalMinute(entry.minute, entry.extraMinute)}:
                </span>
              </span>
              <span className="min-w-0 break-words">
                <span className="font-medium">{entry.side === 'home' ? homeTeam : awayTeam}</span>
                {' · '}
                <span className={entry.playerName === null ? 'text-muted-foreground italic' : ''}>
                  {goalPlayer(entry)}
                </span>
                {etiqueta ? <span className="text-muted-foreground"> ({etiqueta})</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Goles({
  goals,
  homeTeam,
  awayTeam,
}: {
  goals: HistoricalGoals | null;
  homeTeam: string;
  awayTeam: string;
}) {
  const tituloId = useId();

  if (goals === null) {
    return (
      <section aria-labelledby={tituloId} className="flex flex-col gap-2">
        <h3 id={tituloId} className="text-sm font-semibold">
          Goles
        </h3>
        <p className="text-sm text-muted-foreground">
          {NO_DATA}: todavía no se cargó la cronología de goles de este partido.
        </p>
      </section>
    );
  }

  const incompleta = goals.coverage === 'incomplete';
  const sinNada =
    goals.goals.length === 0 && goals.cancelled.length === 0 && goals.shootout.length === 0;

  return (
    <section aria-labelledby={tituloId} className="flex flex-col gap-3">
      <h3 id={tituloId} className="text-sm font-semibold">
        Goles
      </h3>

      {incompleta ? (
        <p role="note" className="text-sm text-muted-foreground">
          Cronología incompleta: la lista no coincide con el marcador y puede faltar algún gol. Se
          muestra lo que informó el proveedor, sin darlo por completo.
        </p>
      ) : null}

      {/* Un 0–0 real (cronología completa y vacía) se dice distinto de «sin dato». */}
      {!incompleta && sinNada ? (
        <p className="text-sm text-muted-foreground">El partido terminó sin goles.</p>
      ) : null}

      {goals.goals.length > 0 ? (
        <GoalList
          titulo={incompleta ? 'Goles registrados' : 'Goles del partido'}
          entries={goals.goals}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
        />
      ) : null}

      {incompleta && goals.goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">El proveedor no informó ningún gol.</p>
      ) : null}

      {goals.cancelled.length > 0 ? (
        <GoalList
          titulo="Goles anulados"
          nota="No suman al marcador."
          entries={goals.cancelled}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
        />
      ) : null}

      {goals.shootout.length > 0 ? (
        <GoalList
          titulo="Tanda de penales"
          nota="Penales convertidos en la definición: no son goles del juego."
          entries={goals.shootout}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
        />
      ) : null}
    </section>
  );
}

/**
 * Estadísticas y goles históricos de un partido terminado, con los datos guardados por el
 * servidor. Los estados nunca se confunden: cargando, error recuperable (con reintento), sin
 * ningún dato cargado, y datos con su cobertura. Una métrica ausente es «Sin dato» (no un cero),
 * una cronología incompleta se avisa como tal, y se dice siempre la fuente y que son datos
 * históricos, sin actualización en vivo.
 *
 * Se monta con `key` por partido; una respuesta que llega después de desmontar se descarta.
 */
export function MatchHistoricalDetail({
  match,
  accessToken,
  onSessionExpired,
}: MatchHistoricalDetailProps) {
  const [lectura, setLectura] = useState<Lectura>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  const token = useRef(accessToken);
  const tituloId = useId();

  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    const accessTokenActual = token.current;
    if (accessTokenActual === null) return;

    const controller = new AbortController();

    getHistoricalDetail(match.id, accessTokenActual, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setLectura({ status: 'ready', detail });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isCancelled(caught)) return;

        setLectura(toError(caught));
      });

    return () => controller.abort();
  }, [match.id, intento]);

  const reintentar = useCallback(() => {
    setLectura({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  const detail = lectura.status === 'ready' ? lectura.detail : null;
  const consultado =
    detail === null ? null : latestFetchedAt(detail.statistics?.fetchedAt, detail.goals?.fetchedAt);

  return (
    <Card className="gap-4 p-4">
      <section aria-labelledby={tituloId} className="flex flex-col gap-4">
        <h2 id={tituloId} className="text-base font-semibold">
          Estadísticas y goles
        </h2>

        {lectura.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando estadísticas y goles…
          </p>
        ) : null}

        {lectura.status === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">
              {lectura.expired ? 'La sesión venció. Iniciá sesión nuevamente.' : lectura.message}
            </p>

            {lectura.expired ? (
              <Button type="button" onClick={onSessionExpired}>
                Iniciar sesión nuevamente
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={reintentar}>
                Reintentar
              </Button>
            )}
          </div>
        ) : null}

        {lectura.status === 'ready' && detail === null ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay estadísticas ni goles cargados para este partido.
          </p>
        ) : null}

        {detail !== null ? (
          <>
            <Estadisticas
              statistics={detail.statistics}
              homeTeam={match.homeTeam}
              awayTeam={match.awayTeam}
            />
            <Goles goals={detail.goals} homeTeam={match.homeTeam} awayTeam={match.awayTeam} />

            <p className="text-xs text-muted-foreground">
              Fuente: API-Football. Datos históricos de un partido terminado
              {consultado ? `, consultados el ${formatFetchedDate(consultado)}` : ''}; no se
              actualizan en vivo.
            </p>
          </>
        ) : null}
      </section>
    </Card>
  );
}
