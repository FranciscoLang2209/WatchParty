import {
  CalendarX,
  Check,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Star,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MatchCard } from '@/features/matches/MatchCard';
import { kickoffDay } from '@/features/matches/format';
import { DirectoryStatePanel } from './DirectoryStatePanel';
import { listMatches } from '@/features/matches/api';
import { MatchesApiError, isCancelled, type Match } from '@/features/matches/types';
import { getOwnProfile } from '@/features/profiles/api';
import { cn } from '@/lib/utils';

type EstadoError = { status: 'error'; message: string; expired: boolean };

type Estado =
  | { status: 'loading' }
  // `actualizando` y `falloActualizacion` no desmontan el listado: las tarjetas
  // siguen en pantalla mientras se vuelve a consultar y si la consulta falla.
  | {
      status: 'ready';
      matches: Match[];
      actualizando: boolean;
      falloActualizacion: string | null;
    }
  | EstadoError;

type Filtro = 'todos' | 'mi-equipo';

const FILTROS: readonly { valor: Filtro; etiqueta: string }[] = [
  { valor: 'todos', etiqueta: 'Todos' },
  { valor: 'mi-equipo', etiqueta: 'Mi equipo' },
];

/**
 * El favorito sale del perfil y se pide aparte del catálogo: si falla, el listado
 * general se conserva y ese fallo nunca se confunde con «no eligió favorito».
 * `idle` es «todavía no se pidió»: sólo se pide al elegir «Mi equipo».
 */
type Favorito =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; teamId: string | null }
  | { status: 'error' };

const MENSAJE_INESPERADO = 'No pudimos cargar el directorio. Intentá de nuevo.';

// `YYYY-MM-DD` es un día de calendario, no un instante: se arma y se formatea en UTC
// para que la zona del dispositivo no lo corra un día.
const diaFormatter = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
});

function formatearDia(fecha: string): string {
  const [anio, mes, dia] = fecha.split('-').map(Number);

  return diaFormatter.format(new Date(Date.UTC(anio!, mes! - 1, dia!)));
}

/** Los estados reales del catálogo que el directorio muestra; `todos` los junta. */
type FiltroEstado = 'todos' | Match['status'];

const OPCIONES_ESTADO: readonly { valor: FiltroEstado; etiqueta: string }[] = [
  { valor: 'todos', etiqueta: 'Todos' },
  { valor: 'live', etiqueta: 'En vivo' },
  { valor: 'scheduled', etiqueta: 'Próximos' },
];

const SIN_PARTIDOS: Partial<Record<Match['status'], string>> = {
  live: 'No hay partidos en vivo por ahora.',
  scheduled: 'No hay partidos próximos por ahora.',
};

/**
 * /rooms sólo muestra partidos que todavía pueden tener sala activa, repartidos en
 * secciones por el estado que ya devuelve el catálogo. Un partido pertenece a una
 * sola sección y, dentro de ella, conserva el orden con que llegó de la API.
 */
const SECCIONES: readonly { estado: Match['status']; titulo: string }[] = [
  { estado: 'live', titulo: 'En vivo' },
  { estado: 'scheduled', titulo: 'Próximos' },
];

function seccionesVisibles(matches: Match[]) {
  return SECCIONES.map(({ estado, titulo }) => ({
    estado,
    titulo,
    matches: matches.filter((match) => match.status === estado),
  })).filter((seccion) => seccion.matches.length > 0);
}

/** El favorito se relaciona por id y no por nombre: `teams.name` no es único. */
function esDelEquipo(match: Match, teamId: string): boolean {
  return match.homeTeamId === teamId || match.awayTeamId === teamId;
}

function SeccionPartidos({
  titulo,
  matches,
  tituloRef,
}: {
  titulo: string;
  matches: Match[];
  /** Destino del foco cuando un reintento termina con partidos. */
  tituloRef?: Ref<HTMLHeadingElement>;
}) {
  const tituloId = useId();

  return (
    <section aria-labelledby={tituloId} className="flex w-full min-w-0 flex-col gap-3">
      <h2
        id={tituloId}
        ref={tituloRef}
        // `tabIndex={-1}` sólo permite recibir el foco por código, no por Tab.
        tabIndex={tituloRef ? -1 : undefined}
        className="rounded-sm font-display text-xl leading-tight font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {titulo}
      </h2>

      <ul className="grid w-full list-none grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {matches.map((match) => (
          <li key={match.id} className="w-full min-w-0">
            <MatchCard match={match} variant="directory" headingLevel="h3" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function toEstadoError(error: unknown): EstadoError {
  if (error instanceof MatchesApiError) {
    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Directorio de salas (WAT-144, F3.2.1): reutiliza el catálogo de partidos ya
 * expuesto por la API — no hay una fuente de datos nueva. El render de cada
 * partido como tarjeta (F3.2.2) y el estado vacío explícito (F3.2.3) llegan
 * en los tickets siguientes de esta misma cadena.
 *
 * «Mi equipo» filtra, sobre lo ya cargado, los partidos del favorito del perfil
 * y conserva las secciones En vivo y Próximos. No pide más partidos: sólo muestra
 * los de la agenda disponible.
 */
export function RoomsDirectoryPage() {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;
  const userId = session?.user.id ?? null;

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [favoritoPedido, setFavoritoPedido] = useState(false);
  // El resultado queda atado a la persona que lo pidió: ante otra sesión no se usa.
  const [favoritoGuardado, setFavoritoGuardado] = useState<{
    userId: string;
    valor: Exclude<Favorito, { status: 'idle' }>;
  } | null>(null);
  const [intentoFavorito, setIntentoFavorito] = useState(0);
  // Destinos del foco durante un reintento: el panel que esté en pantalla (carga,
  // error, sesión vencida, lista vacía o favorito) o, con partidos, el título de la
  // primera sección. Sólo hay uno montado a la vez.
  const panelFoco = useRef<HTMLDivElement>(null);
  const tituloFoco = useRef<HTMLHeadingElement>(null);
  const botonTodos = useRef<HTMLButtonElement>(null);
  const reintentando = useRef(false);
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const botonTodosEstado = useRef<HTMLButtonElement>(null);
  // Día elegido (`YYYY-MM-DD`); vacío no restringe el listado.
  const [fecha, setFecha] = useState('');
  const fechaId = useId();
  const inputFecha = useRef<HTMLInputElement>(null);
  const botonActualizar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null) return;

    const controller = new AbortController();
    let vigente = true;

    listMatches(accessToken, controller.signal)
      .then((matches) => {
        if (vigente) {
          setEstado({ status: 'ready', matches, actualizando: false, falloActualizacion: null });
        }
      })
      .catch((error: unknown) => {
        if (!vigente || isCancelled(error)) return;

        const fallo = toEstadoError(error);

        // Un fallo al actualizar conserva el último listado; la sesión vencida sigue
        // el tratamiento de siempre.
        setEstado((actual) =>
          actual.status === 'ready' && !fallo.expired
            ? { ...actual, actualizando: false, falloActualizacion: fallo.message }
            : fallo,
        );
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [accessToken, intento]);

  // El perfil se pide la primera vez que se elige «Mi equipo» y en su propio efecto,
  // para poder reintentarlo sin volver a pedir el catálogo. Una respuesta que llega
  // después de un cambio de sesión se descarta. Un perfil todavía sin completar
  // (`null`) es «sin favorito», no un fallo.
  useEffect(() => {
    if (!favoritoPedido || accessToken === null || userId === null) return;

    const controller = new AbortController();
    let vigente = true;

    getOwnProfile(accessToken, controller.signal)
      .then((profile) => {
        if (vigente) {
          setFavoritoGuardado({
            userId,
            valor: { status: 'ready', teamId: profile?.favoriteTeamId ?? null },
          });
        }
      })
      .catch(() => {
        if (vigente) setFavoritoGuardado({ userId, valor: { status: 'error' } });
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [favoritoPedido, accessToken, userId, intentoFavorito]);

  const favorito: Favorito = !favoritoPedido
    ? { status: 'idle' }
    : favoritoGuardado !== null && favoritoGuardado.userId === userId
      ? favoritoGuardado.valor
      : { status: 'loading' };

  // Reintentar desmonta el botón que tenía el foco, y al llegar la respuesta se
  // desmonta el panel de carga: sin esto el foco vuelve al body y quien navega con
  // teclado pierde su ubicación. El foco acompaña cada etapa del reintento y queda
  // en el contenido resultante. La carga inicial no lo mueve.
  useEffect(() => {
    if (!reintentando.current) return;

    (panelFoco.current ?? tituloFoco.current)?.focus();

    if (estado.status !== 'loading' && favorito.status !== 'loading') {
      reintentando.current = false;
    }
  }, [estado.status, favorito.status]);

  const reintentar = useCallback(() => {
    reintentando.current = true;
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  // Vuelve a consultar el catálogo ya persistido (no dispara ninguna sincronización).
  // Con una actualización en curso no se pide otra. Quien tenía el foco (el propio
  // botón o el «Reintentar» del aviso) lo deja en «Actualizar», que no desaparece.
  const actualizar = useCallback(() => {
    if (accessToken === null || estado.status !== 'ready' || estado.actualizando) return;

    setEstado({ ...estado, actualizando: true, falloActualizacion: null });
    setIntento((valor) => valor + 1);
    botonActualizar.current?.focus();
  }, [accessToken, estado]);

  const reintentarFavorito = useCallback(() => {
    if (userId === null) return;

    reintentando.current = true;
    setFavoritoGuardado({ userId, valor: { status: 'loading' } });
    setIntentoFavorito((valor) => valor + 1);
  }, [userId]);

  const elegirFiltro = useCallback((siguiente: Filtro) => {
    setFiltro(siguiente);

    if (siguiente === 'mi-equipo') setFavoritoPedido(true);
  }, []);

  // El panel que tenía el foco desaparece al volver: lo recibe «Todos», que sigue
  // en pantalla.
  const volverATodos = useCallback(() => {
    setFiltro('todos');
    botonTodos.current?.focus();
  }, []);

  const partidos = estado.status === 'ready' ? estado.matches : [];
  const todas = seccionesVisibles(partidos);
  const hayPartidos = todas.length > 0;
  const enMiEquipo = hayPartidos && filtro === 'mi-equipo';
  const actualizando = estado.status === 'ready' && estado.actualizando;
  const propias =
    favorito.status === 'ready' && favorito.teamId !== null
      ? seccionesVisibles(partidos.filter((match) => esDelEquipo(match, favorito.teamId!)))
      : [];
  // Con el perfil caído se conserva el listado general; con el favorito resuelto,
  // sólo el suyo; mientras se pide o sin favorito no hay partidos que mostrar. Al
  // actualizar se recalcula sobre los datos nuevos y el filtro elegido se conserva.
  const porEquipo = !enMiEquipo
    ? todas
    : favorito.status === 'error'
      ? todas
      : favorito.status === 'ready'
        ? propias
        : [];
  // El selector de estado sólo recorta las secciones ya calculadas: no pide ni
  // reordena nada.
  const porEstado =
    filtroEstado === 'todos'
      ? porEquipo
      : porEquipo.filter((seccion) => seccion.estado === filtroEstado);
  // La fecha sólo recorta lo ya calculado, por el día en que se juega cada partido
  // en la zona de presentación de la app: no pide nada y las secciones se recalculan.
  const mostradas =
    fecha === ''
      ? porEstado
      : seccionesVisibles(
          porEstado
            .flatMap((seccion) => seccion.matches)
            .filter((partido) => kickoffDay(partido.kickoffAt) === fecha),
        );

  // El panel que tenía el foco desaparece al volver: lo recibe el «Todos» del
  // selector de estado, que sigue en pantalla.
  const volverATodosLosEstados = useCallback(() => {
    setFiltroEstado('todos');
    botonTodosEstado.current?.focus();
  }, []);

  // El control que tenía el foco desaparece al quitar la fecha: lo recibe el campo.
  const quitarFecha = useCallback(() => {
    setFecha('');
    inputFecha.current?.focus();
  }, []);

  return (
    <section
      aria-busy={
        estado.status === 'loading' || actualizando || (enMiEquipo && favorito.status === 'loading')
      }
      className="flex w-full flex-1 flex-col overflow-x-hidden"
    >
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex min-w-0 flex-col gap-2">
          <h1 className="font-display text-3xl leading-tight font-semibold break-words sm:text-4xl">
            Salas
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            Elegí un partido en vivo o próximo para entrar a su sala.
          </p>
        </header>

        {estado.status === 'ready' ? (
          <div className="flex flex-wrap items-end justify-between gap-3">
            {hayPartidos ? (
              <div className="flex flex-wrap items-end gap-3">
                <div role="group" aria-label="Filtrar partidos" className="flex flex-wrap gap-2">
                  {FILTROS.map(({ valor, etiqueta }) => (
                    <Button
                      key={valor}
                      ref={valor === 'todos' ? botonTodos : undefined}
                      type="button"
                      variant={filtro === valor ? 'default' : 'outline'}
                      aria-pressed={filtro === valor}
                      className="flex-1 sm:flex-none"
                      onClick={() => elegirFiltro(valor)}
                    >
                      {filtro === valor ? <Check aria-hidden="true" /> : null}
                      {etiqueta}
                    </Button>
                  ))}
                </div>

                <div role="group" aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
                  {OPCIONES_ESTADO.map(({ valor, etiqueta }) => (
                    <Button
                      key={valor}
                      ref={valor === 'todos' ? botonTodosEstado : undefined}
                      type="button"
                      variant={filtroEstado === valor ? 'default' : 'outline'}
                      aria-pressed={filtroEstado === valor}
                      className="flex-1 sm:flex-none"
                      onClick={() => setFiltroEstado(valor)}
                    >
                      {filtroEstado === valor ? <Check aria-hidden="true" /> : null}
                      {etiqueta}
                    </Button>
                  ))}
                </div>

                <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto">
                  <Label htmlFor={fechaId}>Filtrar por fecha</Label>
                  <Input
                    ref={inputFecha}
                    id={fechaId}
                    type="date"
                    value={fecha}
                    onChange={(evento) => setFecha(evento.target.value)}
                  />
                </div>

                {fecha !== '' ? (
                  <Button type="button" variant="ghost" onClick={quitarFecha}>
                    Quitar fecha
                  </Button>
                ) : null}
              </div>
            ) : null}

            <Button
              ref={botonActualizar}
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              // No se usa `disabled`: sacaría el foco del botón mientras actualiza.
              aria-disabled={actualizando}
              aria-busy={actualizando}
              onClick={actualizar}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn(actualizando && 'animate-spin motion-reduce:animate-none')}
              />
              {actualizando ? 'Actualizando…' : 'Actualizar'}
            </Button>
          </div>
        ) : null}

        {estado.status === 'loading' ? (
          <DirectoryStatePanel
            role="status"
            icon={LoaderCircle}
            spin
            title="Un momento"
            message="Cargando el directorio…"
            panelRef={panelFoco}
          />
        ) : null}

        {estado.status === 'error' && estado.expired ? (
          // La sesión vencida no es un fallo recuperable: se resuelve con el flujo
          // de Auth existente, así que no se ofrece reintentar.
          <DirectoryStatePanel
            role="alert"
            icon={LogIn}
            title="Necesitás ingresar de nuevo"
            message={estado.message}
            panelRef={panelFoco}
            action={
              <Button type="button" className="w-full sm:w-auto" onClick={() => void signOut()}>
                Iniciar sesión nuevamente
              </Button>
            }
          />
        ) : null}

        {estado.status === 'error' && !estado.expired ? (
          <DirectoryStatePanel
            role="alert"
            tone="error"
            icon={TriangleAlert}
            title="Algo salió mal"
            message={estado.message}
            panelRef={panelFoco}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={reintentar}
              >
                Reintentar
              </Button>
            }
          />
        ) : null}

        {estado.status === 'ready' && estado.falloActualizacion !== null ? (
          <DirectoryStatePanel
            role="alert"
            tone="error"
            icon={TriangleAlert}
            title="No pudimos actualizar"
            message={`${estado.falloActualizacion} Seguimos mostrando el último listado.`}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={actualizar}
              >
                Reintentar
              </Button>
            }
          />
        ) : null}

        {estado.status === 'ready' && !hayPartidos ? (
          <DirectoryStatePanel
            icon={CalendarX}
            title="No hay partidos por ahora"
            message="Todavía no hay partidos ni salas disponibles. Volvé más tarde."
            panelRef={panelFoco}
          />
        ) : null}

        {enMiEquipo && favorito.status === 'loading' ? (
          <DirectoryStatePanel
            role="status"
            icon={LoaderCircle}
            spin
            title="Un momento"
            message="Buscando las salas de tu equipo…"
            panelRef={panelFoco}
          />
        ) : null}

        {enMiEquipo && favorito.status === 'error' ? (
          // El fallo del perfil no es «sin favorito»: se avisa, se deja reintentar y
          // mientras tanto queda el listado general.
          <DirectoryStatePanel
            role="alert"
            tone="error"
            icon={TriangleAlert}
            title="No pudimos cargar tu equipo"
            message="No pudimos obtener tu equipo favorito. Mientras tanto, mostramos todos los partidos."
            panelRef={panelFoco}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={reintentarFavorito}
              >
                Reintentar
              </Button>
            }
          />
        ) : null}

        {enMiEquipo && favorito.status === 'ready' && favorito.teamId === null ? (
          <DirectoryStatePanel
            role="status"
            icon={Star}
            title="Todavía no elegiste un equipo"
            message="Elegí tu equipo favorito en tu perfil para ver acá las salas de sus partidos."
            panelRef={panelFoco}
            action={
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <Link to="/profile">Elegir equipo favorito</Link>
              </Button>
            }
          />
        ) : null}

        {enMiEquipo &&
        favorito.status === 'ready' &&
        favorito.teamId !== null &&
        propias.length === 0 ? (
          <DirectoryStatePanel
            role="status"
            icon={CalendarX}
            title="No hay partidos de tu equipo"
            message="No hay partidos de tu equipo favorito en la agenda disponible."
            panelRef={panelFoco}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={volverATodos}
              >
                Ver todos los partidos
              </Button>
            }
          />
        ) : null}

        {porEquipo.length > 0 && porEstado.length === 0 ? (
          <DirectoryStatePanel
            role="status"
            icon={CalendarX}
            title="No hay partidos para mostrar"
            message={SIN_PARTIDOS[filtroEstado as Match['status']] ?? ''}
            panelRef={panelFoco}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={volverATodosLosEstados}
              >
                Ver todos los partidos
              </Button>
            }
          />
        ) : null}

        {porEstado.length > 0 && fecha !== '' && mostradas.length === 0 ? (
          <DirectoryStatePanel
            role="status"
            icon={CalendarX}
            title="No hay partidos ese día"
            message={`No hay partidos el ${formatearDia(fecha)} en la agenda disponible.`}
            panelRef={panelFoco}
            action={
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={quitarFecha}
              >
                Ver todos los días
              </Button>
            }
          />
        ) : null}

        {mostradas.map(({ estado: estadoPartido, titulo, matches }, posicion) => (
          <SeccionPartidos
            key={estadoPartido}
            titulo={titulo}
            matches={matches}
            tituloRef={posicion === 0 ? tituloFoco : undefined}
          />
        ))}
      </div>
    </section>
  );
}
