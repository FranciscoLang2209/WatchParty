import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { getOwnProfile, listTeams, saveOwnProfile } from '@/features/profiles/api';
import { ProfileFields, type ProfileFieldErrors } from '@/features/profiles/ProfileFields';
import {
  ProfilesApiError,
  isCancelled,
  type Profile,
  type TeamOption,
} from '@/features/profiles/types';

type Estado =
  | { status: 'loading' }
  | { status: 'ready'; profile: Profile | null; teams: TeamOption[] }
  | { status: 'error'; message: string; expired: boolean };

/** El formulario en curso. Se siembra con lo que responde la API. */
interface Borrador {
  displayName: string;
  bio: string;
  favoriteTeamId: string | null;
}

const BORRADOR_VACIO: Borrador = { displayName: '', bio: '', favoriteTeamId: null };

const MENSAJE_INESPERADO = 'No pudimos cargar tu perfil. Intentá de nuevo.';
const NOMBRE_REQUERIDO = 'El nombre visible es obligatorio.';

/** El valor vacío del selector es «sin favorito», que se guarda como `null`. */
const SIN_FAVORITO = '';

function toBorrador(profile: Profile | null): Borrador {
  return profile === null ? BORRADOR_VACIO : { ...profile };
}

function toEstadoError(error: unknown): Estado {
  if (error instanceof ProfilesApiError) {
    return { status: 'error', message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { status: 'error', message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Perfil propio: nombre visible, biografía y equipo favorito.
 *
 * Consume sólo la Node API autenticada — la sesión aporta el bearer y nada más.
 * Carga, ausencia de perfil, error y sesión vencida son estados distintos: un
 * fallo nunca se presenta como «todavía no tenés perfil», que es una respuesta
 * válida del contrato (`profile: null`).
 */
export function ProfilePage() {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;

  const favoriteId = useId();
  const feedbackId = useId();

  const [estado, setEstado] = useState<Estado>({ status: 'loading' });
  const [intento, setIntento] = useState(0);

  const [borrador, setBorrador] = useState<Borrador>(BORRADOR_VACIO);
  const [errores, setErrores] = useState<ProfileFieldErrors>({});
  const [mensajeGuardado, setMensajeGuardado] = useState<string | null>(null);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    // Sin token no hay nada que pedir: el guard de rutas privadas se encarga.
    if (accessToken === null) return;

    const controller = new AbortController();
    let vigente = true;

    // Las dos consultas viajan juntas: la pantalla no sirve a medias.
    Promise.all([
      getOwnProfile(accessToken, controller.signal),
      listTeams(accessToken, controller.signal),
    ])
      .then(([profile, teams]) => {
        if (!vigente) return;

        setEstado({ status: 'ready', profile, teams });
        setBorrador(toBorrador(profile));
      })
      .catch((error: unknown) => {
        // Una respuesta descartada por desmontaje o cambio de token no se anuncia.
        if (!vigente || isCancelled(error)) return;

        setEstado(toEstadoError(error));
      });

    return () => {
      vigente = false;
      controller.abort();
    };
  }, [accessToken, intento]);

  const reintentar = useCallback(() => {
    setEstado({ status: 'loading' });
    setIntento((valor) => valor + 1);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (guardando || accessToken === null) return;

    setMensajeGuardado(null);
    setErrorGuardado(null);
    setErrores({});

    // El nombre es obligatorio: no tiene sentido gastar un viaje para que el
    // backend devuelva el mismo 400 que ya podemos anticipar.
    if (borrador.displayName.trim().length === 0) {
      setErrores({ displayName: NOMBRE_REQUERIDO });
      return;
    }

    setGuardando(true);

    try {
      const guardado = await saveOwnProfile(borrador, accessToken);

      // Lo que se muestra es la respuesta, no lo que se tipeó: el backend puede
      // normalizar, y la pantalla tiene que reflejar lo que quedó guardado.
      setEstado((actual) =>
        actual.status === 'ready' ? { ...actual, profile: guardado } : actual,
      );
      setBorrador(toBorrador(guardado));
      setMensajeGuardado('Guardamos tu perfil.');
    } catch (error) {
      if (isCancelled(error)) return;

      setErrorGuardado(
        error instanceof ProfilesApiError
          ? error.message
          : 'No pudimos guardar tu perfil. Intentá de nuevo.',
      );
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="font-display text-3xl leading-tight font-semibold">Tu perfil</h1>

        {estado.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando tu perfil…
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

        {estado.status === 'ready' ? (
          <form
            className="flex w-full min-w-0 flex-col gap-4"
            onSubmit={handleSubmit}
            aria-busy={guardando}
            aria-describedby={feedbackId}
            noValidate
          >
            {estado.profile === null ? (
              // No es un fallo: es alguien que todavía no lo completó.
              <p className="text-sm text-muted-foreground">
                Todavía no completaste tu perfil. Contá quién sos para que te reconozcan en la
                tribuna.
              </p>
            ) : null}

            <ProfileFields
              displayName={borrador.displayName}
              bio={borrador.bio}
              onDisplayNameChange={(displayName) =>
                setBorrador((actual) => ({ ...actual, displayName }))
              }
              onBioChange={(bio) => setBorrador((actual) => ({ ...actual, bio }))}
              errors={errores}
              disabled={guardando}
            />

            <div className="flex w-full min-w-0 flex-col gap-2">
              <Label htmlFor={favoriteId}>Equipo favorito</Label>

              <select
                id={favoriteId}
                className="flex h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                value={borrador.favoriteTeamId ?? SIN_FAVORITO}
                disabled={guardando}
                onChange={(event) =>
                  setBorrador((actual) => ({
                    ...actual,
                    // Elegir la opción vacía es, exactamente, quitar el favorito.
                    favoriteTeamId: event.target.value === SIN_FAVORITO ? null : event.target.value,
                  }))
                }
              >
                <option value={SIN_FAVORITO}>Sin equipo favorito</option>
                {estado.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>

            <div id={feedbackId} className="empty:hidden">
              {errorGuardado !== null ? (
                <p
                  role="alert"
                  aria-live="assertive"
                  className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {errorGuardado}
                </p>
              ) : null}

              {mensajeGuardado !== null ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="rounded-sm border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground"
                >
                  {mensajeGuardado}
                </p>
              ) : null}
            </div>

            <Button type="submit" size="lg" className="w-full font-semibold" disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
