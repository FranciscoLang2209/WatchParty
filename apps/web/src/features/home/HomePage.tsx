import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MatchCard } from '@/features/matches/MatchCard';
import { listMatches } from '@/features/matches/api';
import { MatchesApiError, isCancelled, type Match } from '@/features/matches/types';
import { getOwnProfile } from '@/features/profiles/api';
import { FavoriteRoomCard } from './FavoriteRoomCard';
import { findFavoriteMatch } from './favorite-room';

type Estado =
  | { status: 'loading' }
  // `loadedAt` es el «ahora» contra el que se decide qué partido es próximo.
  | { status: 'ready'; matches: Match[]; loadedAt: Date }
  | { status: 'error'; message: string; expired: boolean };

/**
 * El favorito se carga aparte del catálogo: si el perfil falla, el listado se
 * muestra igual, y ese fallo nunca se confunde con «no eligió favorito».
 */
type Favorito =
  { status: 'loading' } | { status: 'ready'; teamId: string | null } | { status: 'error' };

const MENSAJE_INESPERADO = 'No pudimos cargar los partidos. Intentá de nuevo.';

function toEstadoError(error: unknown): Estado {
  if (error instanceof MatchesApiError) {
    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Home privada: destaca la sala del partido del equipo favorito y lista los
 * partidos que sirve la Node API.
 *
 * No consulta Supabase: la sesión sólo aporta el bearer. Carga, lista vacía,
 * error y sesión vencida son estados distintos — un fallo nunca se presenta como
 * «no hay partidos». «Sin favorito» y «sin partido del favorito» tampoco son
 * errores: son mensajes propios, arriba del listado.
 */
export function HomePage() {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [favorito, setFavorito] = useState<Favorito>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null) return;

    const controller = new AbortController();
    let vigente = true;

    listMatches(accessToken, controller.signal)
      .then((matches) => {
        if (vigente) setEstado({ status: 'ready', matches, loadedAt: new Date() });
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje o cambio de token no se anuncia.
        if (!vigente || isCancelled(error)) return;

        setEstado(toEstadoError(error));
      });

    // Un perfil todavía sin completar (`null`) es «sin favorito», no un fallo.
    getOwnProfile(accessToken, controller.signal)
      .then((profile) => {
        if (vigente) setFavorito({ status: 'ready', teamId: profile?.favoriteTeamId ?? null });
      })
      .catch(() => {
        if (vigente) setFavorito({ status: 'error' });
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [accessToken, intento]);

  // El anuncio de carga se dispara acá y no dentro del efecto: con
  // `autoRefreshToken`, el token se renueva solo cada tanto y volver a
  // «Cargando…» en cada renovación sería una molestia, no información.
  const reintentar = useCallback(() => {
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  // Se calcula sobre lo ya cargado: ni la tarjeta ni los fallbacks piden nada.
  const partidoFavorito =
    estado.status === 'ready' && favorito.status === 'ready'
      ? findFavoriteMatch({
          favoriteTeamId: favorito.teamId,
          matches: estado.matches,
          now: estado.loadedAt,
        })
      : null;

  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <h1 className="sr-only">Inicio</h1>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
        {estado.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando partidos…
          </p>
        ) : null}

        {estado.status === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{estado.message}</p>

            {estado.expired ? (
              // La sesión vencida se resuelve con el flujo de Auth existente: al
              // quedar sin sesión, el guard redirige a la pantalla de acceso.
              <Button type="button" onClick={() => void signOut()}>
                Iniciar sesión nuevamente
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={reintentar}>
                Reintentar
              </Button>
            )}
          </div>
        ) : null}

        {estado.status === 'ready' && accessToken !== null ? (
          <>
            {partidoFavorito !== null ? (
              <FavoriteRoomCard
                match={partidoFavorito}
                accessToken={accessToken}
                onSessionExpired={() => void signOut()}
              />
            ) : null}

            {favorito.status === 'ready' && favorito.teamId === null ? (
              <Card className="items-start gap-3 p-4">
                <p className="text-sm text-muted-foreground">
                  Todavía no elegiste un equipo favorito. Elegilo en tu perfil para ver acá la sala
                  de su próximo partido.
                </p>

                <Link
                  to="/profile"
                  className="rounded-sm text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  Elegir equipo favorito
                </Link>
              </Card>
            ) : null}

            {favorito.status === 'ready' && favorito.teamId !== null && partidoFavorito === null ? (
              <Card className="p-4">
                <p className="text-sm text-muted-foreground">
                  Tu equipo favorito no tiene partidos en vivo ni próximos por ahora.
                </p>
              </Card>
            ) : null}

            {favorito.status === 'error' ? (
              <p className="text-sm text-muted-foreground">No pudimos cargar tu equipo favorito.</p>
            ) : null}
          </>
        ) : null}

        {estado.status === 'ready' && estado.matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay partidos disponibles. Volvé más tarde.
          </p>
        ) : null}

        {estado.status === 'ready' && estado.matches.length > 0 ? (
          <ul className="flex w-full list-none flex-col gap-3">
            {estado.matches.map((match) => (
              <li key={match.id} className="w-full min-w-0">
                <MatchCard match={match} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
