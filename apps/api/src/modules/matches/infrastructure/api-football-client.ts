export interface FetchFixturesPageParams {
  league: number;
  season: number;
  from: string;
  to: string;
  page: number;
}

export type ApiFootballFetchOutcome =
  | { kind: 'response'; status: number; ok: boolean; body: unknown; paging: unknown }
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
  return {
    async fetchFixturesPage(
      params: FetchFixturesPageParams,
      signal?: AbortSignal,
    ): Promise<ApiFootballFetchOutcome> {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const url = new URL('/fixtures', baseUrl);
      url.searchParams.set('league', String(params.league));
      url.searchParams.set('season', String(params.season));
      url.searchParams.set('from', params.from);
      url.searchParams.set('to', params.to);
      url.searchParams.set('page', String(params.page));

      try {
        const response = await fetchFn(url, {
          headers: { 'x-apisports-key': apiKey },
          signal: combinedSignal,
        });

        let body: unknown;
        try {
          body = await response.json();
        } catch {
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
    },
  };
}
