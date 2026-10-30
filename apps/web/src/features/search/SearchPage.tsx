import { Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MatchCard } from '@/features/matches/MatchCard';
import { searchMatches } from '@/features/matches/api';
import { MatchesApiError, isCancelled, isUnauthorized, type Match } from '@/features/matches/types';

type Estado =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; query: string; matches: Match[]; hayMas: boolean }
  | { status: 'error'; query: string; message: string; expired: boolean };

/** Debe coincidir con el máximo que acepta la API para `q`. */
const TEXTO_MAX = 100;
const MENSAJE_VACIO = 'Escribí el nombre de un equipo para buscar.';
const MENSAJE_INESPERADO = 'No pudimos completar la búsqueda. Intentá de nuevo.';

/** Tope de reintentos por token renovado dentro de una misma petición. */
const REINTENTOS_TOKEN_MAX = 3;

/**
 * Pide una página con el token con que arrancó la petición. Si responde 401 pero
 * el token ya fue reemplazado (renovación en vuelo), el 401 es del token viejo y
 * no de la sesión: reintenta con el vigente. Un 401 con el token que sigue
 * vigente es vencimiento real y se propaga.
 */
async function pedirPagina(
  query: string,
  token: string,
  tokenVigente: { readonly current: string | null },
  signal: AbortSignal,
) {
  let usado = token;

  for (let reintento = 0; ; reintento += 1) {
    try {
      return await searchMatches(query, usado, { signal });
    } catch (error) {
      const vigente = tokenVigente.current;

      if (
        !isUnauthorized(error) ||
        signal.aborted ||
        vigente === null ||
        vigente === usado ||
        reintento >= REINTENTOS_TOKEN_MAX
      ) {
        throw error;
      }

      usado = vigente;
    }
  }
}

function toEstadoError(query: string, error: unknown): Estado {
  if (error instanceof MatchesApiError) {
    return {
      status: 'error',
      query,
      message: error.message,
      expired: error.kind === 'unauthorized',
    };
  }

  return { status: 'error', query, message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Pantalla de búsqueda (WAT-241). Consulta sólo al enviar el formulario — con el
 * botón o con Enter —, nunca al escribir. Muestra la primera página de la API;
 * cargar las siguientes no forma parte de este ticket, así que si hay más
 * resultados se avisa en vez de mostrar una lista que parece completa.
 *
 * Renovar el token no cancela la búsqueda en curso: si ésta responde 401 por el
 * token reemplazado, se reintenta con el vigente en vez de mostrar la sesión
 * como vencida.
 */
export function SearchPage() {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;

  const campoId = useId();
  const errorId = useId();

  const [texto, setTexto] = useState('');
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [estado, setEstado] = useState<Estado>({ status: 'idle' });
  // La última búsqueda en curso: una nueva, o salir de la pantalla, descarta su respuesta.
  const controllerRef = useRef<AbortController | null>(null);
  // El token vigente, para reintentar una petición cuyo token se renovó mientras tanto.
  const tokenRef = useRef(accessToken);

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const buscar = useCallback(
    (query: string) => {
      if (accessToken === null) return;

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setEstado({ status: 'loading' });

      pedirPagina(query, accessToken, tokenRef, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;

          setEstado({
            status: 'ready',
            query,
            matches: page.matches,
            hayMas: page.nextCursor !== null,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isCancelled(error)) return;

          setEstado(toEstadoError(query, error));
        });
    },
    [accessToken],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const query = texto.trim();

    if (query === '') {
      controllerRef.current?.abort();
      setErrorCampo(MENSAJE_VACIO);
      setEstado({ status: 'idle' });
      return;
    }

    setErrorCampo(null);
    buscar(query);
  }

  function handleChange(value: string) {
    setTexto(value);
    if (errorCampo !== null) setErrorCampo(null);
  }

  return (
    <section className="flex w-full flex-1 flex-col overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex min-w-0 flex-col gap-2">
          <h1 className="font-display text-3xl leading-tight font-semibold break-words sm:text-4xl">
            Buscar
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            Encontrá un partido por el nombre de un equipo, pasado o futuro.
          </p>
        </header>

        <form
          role="search"
          noValidate
          onSubmit={handleSubmit}
          className="flex min-w-0 flex-col gap-2"
        >
          <Label htmlFor={campoId}>Equipo</Label>

          <div className="flex min-w-0 gap-2">
            <Input
              id={campoId}
              type="search"
              name="q"
              value={texto}
              maxLength={TEXTO_MAX}
              autoComplete="off"
              enterKeyHint="search"
              placeholder="Ej.: River Plate"
              aria-invalid={errorCampo !== null}
              aria-describedby={errorCampo !== null ? errorId : undefined}
              onChange={(event) => handleChange(event.target.value)}
            />

            <Button type="submit" className="shrink-0" aria-busy={estado.status === 'loading'}>
              <Search aria-hidden="true" />
              Buscar
            </Button>
          </div>

          {errorCampo !== null ? (
            <p
              id={errorId}
              role="alert"
              className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {errorCampo}
            </p>
          ) : null}
        </form>

        {estado.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Buscando…
          </p>
        ) : null}

        {estado.status === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{estado.message}</p>

            {estado.expired ? (
              // La sesión vencida se resuelve con el flujo de Auth, no con un reintento.
              <Button type="button" onClick={() => void signOut()}>
                Iniciar sesión nuevamente
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => buscar(estado.query)}>
                Reintentar
              </Button>
            )}
          </div>
        ) : null}

        {estado.status === 'ready' ? (
          <section aria-label="Resultados de la búsqueda" className="flex min-w-0 flex-col gap-4">
            <p role="status" className="text-sm text-muted-foreground">
              {estado.matches.length === 0
                ? `No encontramos partidos para «${estado.query}».`
                : `${estado.matches.length} ${estado.matches.length === 1 ? 'partido' : 'partidos'} para «${estado.query}».`}
            </p>

            {estado.matches.length > 0 ? (
              <ul className="grid w-full list-none grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {estado.matches.map((match) => (
                  <li key={match.id} className="w-full min-w-0">
                    <MatchCard match={match} />
                  </li>
                ))}
              </ul>
            ) : null}

            {estado.hayMas ? (
              <p className="text-sm text-muted-foreground">
                Hay más resultados. Probá con un nombre más específico para acotarlos.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </section>
  );
}
