export interface FetchFixturesPageParams {
  league: number;
  season: number;
  from: string;
  to: string;
  page: number;
}

/** Pedido de un solo fixture por su id (`GET /fixtures?id=`), para verificar una correspondencia. */
export interface FetchFixtureByIdParams {
  fixtureId: number;
}

export type ApiFootballFetchOutcome =
  | {
      kind: 'response';
      status: number;
      ok: boolean;
      body: unknown;
      paging: unknown;
      headers: Record<string, string>;
    }
  | { kind: 'timeout' }
  | { kind: 'network-error'; message: string };

export interface ApiFootballClientDeps {
  fetchFn: typeof fetch;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createApiFootballClient({
  fetchFn,
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ApiFootballClientDeps) {
  // Un único camino para todos los pedidos: mismo timeout, misma clave en el header (nunca en la
  // URL) y mismo resultado tipado. Nunca lanza: un fallo se devuelve como `timeout` o `network-error`.
  async function get(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ApiFootballFetchOutcome> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    const url = new URL(path, baseUrl);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }

    try {
      const response = await fetchFn(url, {
        headers: { 'x-apisports-key': apiKey },
        signal: combinedSignal,
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch (jsonError) {
        if (timeoutController.signal.aborted) {
          throw jsonError;
        }
        body = undefined;
      }

      const rawPaging =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>).paging
          : undefined;

      return {
        kind: 'response',
        status: response.status,
        ok: response.ok,
        body,
        paging: rawPaging,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      if (timeoutController.signal.aborted) {
        return { kind: 'timeout' };
      }

      const message = error instanceof Error ? error.message : 'unknown fetch error';
      return { kind: 'network-error', message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    fetchFixturesPage(
      params: FetchFixturesPageParams,
      signal?: AbortSignal,
    ): Promise<ApiFootballFetchOutcome> {
      const query: Record<string, string> = {
        league: String(params.league),
        season: String(params.season),
        from: params.from,
        to: params.to,
      };
      if (params.page > 1) {
        query.page = String(params.page);
      }

      return get('/fixtures', query, signal);
    },

    /** `GET /fixtures?id=`: el fixture con sus equipos, fecha, liga y marcador. */
    fetchFixtureById(
      params: FetchFixtureByIdParams,
      signal?: AbortSignal,
    ): Promise<ApiFootballFetchOutcome> {
      return get('/fixtures', { id: String(params.fixtureId) }, signal);
    },

    /** `GET /fixtures/statistics?fixture=`: estadísticas por equipo. */
    fetchFixtureStatistics(
      params: FetchFixtureByIdParams,
      signal?: AbortSignal,
    ): Promise<ApiFootballFetchOutcome> {
      return get('/fixtures/statistics', { fixture: String(params.fixtureId) }, signal);
    },

    /** `GET /fixtures/events?fixture=`: goles, anulaciones y otros eventos. */
    fetchFixtureEvents(
      params: FetchFixtureByIdParams,
      signal?: AbortSignal,
    ): Promise<ApiFootballFetchOutcome> {
      return get('/fixtures/events', { fixture: String(params.fixtureId) }, signal);
    },
  };
}

export type ApiFootballClient = ReturnType<typeof createApiFootballClient>;
