import { Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MatchSummaryCard } from '@/features/matches/MatchSummaryCard';
import { searchMatches } from '@/features/matches/api';
import { MatchesApiError, isCancelled, isUnauthorized, type Match } from '@/features/matches/types';

/** Carga de la página siguiente: un fallo acá no toca los resultados ya mostrados. */
type PaginaSiguiente =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string; expired: boolean };

type Estado =
  // Todavía no se buscó nada.
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      query: string;
      matches: Match[];
      /** `null` cuando no hay otra página. */
      nextCursor: string | null;
      siguiente: PaginaSiguiente;
    }
  | { status: 'error'; query: string; message: string; expired: boolean };

/** Debe coincidir con el máximo que acepta la API para `q`. */
const TEXTO_MAX = 100;
/** Tamaño de página de la API (WAT-240). */
const PAGE_SIZE = 20;
const MENSAJE_VACIO = 'Escribí el nombre de un equipo para buscar.';
const MENSAJE_INESPERADO = 'No pudimos completar la búsqueda. Intentá de nuevo.';

function describirError(error: unknown): { message: string; expired: boolean } {
  if (error instanceof MatchesApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO, expired: false };
}

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
  options: Parameters<typeof searchMatches>[2],
) {
  let usado = token;

  for (let reintento = 0; ; reintento += 1) {
    try {
      return await searchMatches(query, usado, options);
    } catch (error) {
      const vigente = tokenVigente.current;

      if (
        !isUnauthorized(error) ||
        options?.signal?.aborted ||
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

/** Suma la página nueva sin repetir partidos que ya estaban (por id) y conserva el orden. */
function sinRepetidos(existentes: Match[], nuevos: Match[]): Match[] {
  const vistos = new Set(existentes.map((match) => match.id));

  return [...existentes, ...nuevos.filter((match) => !vistos.has(match.id))];
}

/**
 * Pantalla de búsqueda (WAT-241, WAT-243). Consulta sólo al enviar el formulario
 * — con el botón o con Enter —, nunca al escribir.
 *
 * Sólo cuenta la última petición: una búsqueda nueva, un cambio de sesión o salir
 * de la pantalla abortan lo que esté en curso y su respuesta se descarta aunque
 * llegue tarde. Una búsqueda nueva siempre arranca de la primera página.
 *
 * Renovar el token no cancela la petición en curso: si ésta responde 401 por el
 * token reemplazado, se reintenta con el vigente sin tocar los resultados.
 */
export function SearchPage() {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;
  // Identifica a la persona, no al token: renovarlo no cambia de sesión.
  const userId = session?.user.id ?? null;

  const campoId = useId();
  const errorId = useId();

  const [texto, setTexto] = useState('');
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [estado, setEstado] = useState<Estado>({ status: 'idle' });
  // La petición vigente (primera página o «Cargar más»); sólo hay una a la vez.
  const controllerRef = useRef<AbortController | null>(null);
  // El token vigente al momento de pedir, sin volver a crear los callbacks al renovarse.
  const tokenRef = useRef(accessToken);
  // Destino del foco cuando «Cargar más» desaparece por ser la última página.
  const resumenRef = useRef<HTMLParagraphElement>(null);
  const cargarMasRef = useRef<HTMLButtonElement>(null);
  const enfocarResumen = useRef(false);

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  // Otra persona en la misma pantalla no hereda resultados ni búsquedas de la anterior.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setTexto('');
      setErrorCampo(null);
      setEstado({ status: 'idle' });
    };
  }, [userId]);

  useEffect(() => {
    if (!enfocarResumen.current) return;

    enfocarResumen.current = false;
    resumenRef.current?.focus();
  }, [estado]);

  const buscar = useCallback((query: string) => {
    const token = tokenRef.current;

    if (token === null) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setEstado({ status: 'loading' });

    pedirPagina(query, token, tokenRef, { limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;

        setEstado({
          status: 'ready',
          query,
          matches: sinRepetidos([], page.matches),
          nextCursor: page.nextCursor,
          siguiente: { status: 'idle' },
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isCancelled(error)) return;

        setEstado({ status: 'error', query, ...describirError(error) });
      });
  }, []);

  const cargarMas = useCallback(() => {
    const token = tokenRef.current;

    if (token === null || estado.status !== 'ready') return;
    if (estado.nextCursor === null || estado.siguiente.status === 'loading') return;

    const { query, nextCursor } = estado;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setEstado({ ...estado, siguiente: { status: 'loading' } });

    pedirPagina(query, token, tokenRef, {
      cursor: nextCursor,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted) return;

        // Sólo se traslada el foco si seguía en «Cargar más»: si la persona pasó al
        // campo o a otro control mientras esperaba, no se le interrumpe.
        const teniaElFoco = document.activeElement === cargarMasRef.current;

        setEstado((actual) => {
          if (actual.status !== 'ready' || actual.query !== query) return actual;

          return {
            ...actual,
            matches: sinRepetidos(actual.matches, page.matches),
            nextCursor: page.nextCursor,
            siguiente: { status: 'idle' },
          };
        });

        // El botón se va con la última página: el foco pasa al resumen.
        if (page.nextCursor === null && teniaElFoco) enfocarResumen.current = true;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isCancelled(error)) return;

        // Los resultados que ya estaban se conservan: sólo falla la página siguiente.
        setEstado((actual) =>
          actual.status === 'ready' && actual.query === query
            ? { ...actual, siguiente: { status: 'error', ...describirError(error) } }
            : actual,
        );
      });
  }, [estado]);

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

        {estado.status === 'idle' ? (
          <p className="text-sm text-muted-foreground">
            Escribí el nombre de un equipo y apretá Buscar para ver sus partidos.
          </p>
        ) : null}

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
            <p
              ref={resumenRef}
              role="status"
              // `tabIndex={-1}` sólo permite recibir el foco por código, no por Tab.
              tabIndex={-1}
              className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {estado.matches.length === 0
                ? `No encontramos partidos para «${estado.query}».`
                : `${estado.matches.length} ${estado.matches.length === 1 ? 'partido' : 'partidos'} para «${estado.query}».`}
            </p>

            {estado.matches.length > 0 ? (
              <ul className="grid w-full list-none grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {estado.matches.map((match) => (
                  <li key={match.id} className="w-full min-w-0">
                    <MatchSummaryCard match={match} />
                  </li>
                ))}
              </ul>
            ) : null}

            {estado.siguiente.status === 'error' ? (
              <p role="alert" className="text-sm text-destructive">
                {estado.siguiente.message}
              </p>
            ) : null}

            {estado.siguiente.status === 'error' && estado.siguiente.expired ? (
              <Button type="button" className="self-start" onClick={() => void signOut()}>
                Iniciar sesión nuevamente
              </Button>
            ) : null}

            {estado.nextCursor !== null &&
            !(estado.siguiente.status === 'error' && estado.siguiente.expired) ? (
              <Button
                ref={cargarMasRef}
                type="button"
                variant="outline"
                className="w-full self-start sm:w-auto"
                aria-busy={estado.siguiente.status === 'loading'}
                aria-disabled={estado.siguiente.status === 'loading'}
                onClick={cargarMas}
              >
                {estado.siguiente.status === 'loading'
                  ? 'Cargando…'
                  : estado.siguiente.status === 'error'
                    ? 'Reintentar'
                    : 'Cargar más'}
              </Button>
            ) : null}
          </section>
        ) : null}
      </div>
    </section>
  );
}
