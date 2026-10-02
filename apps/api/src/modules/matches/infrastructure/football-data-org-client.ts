/**
 * Cliente HTTP de football-data.org (WAT-181). Mismo criterio que
 * `api-football-client.ts`: solo hace el pedido y expone la respuesta cruda
 * (status, body, headers) sin interpretar nada — la normalización vive aparte,
 * en `application/football-data-org-normalizer.ts`.
 *
 * A diferencia de API-Football, esta API no pagina por `page`: una sola
 * consulta a `/competitions/:code/matches` devuelve todos los partidos de la
 * temporada vigente (confirmado en docs/integrations/football-data-org-coverage.md).
 */
export interface FetchFootballDataOrgMatchesParams {
  /** Código de competición del proveedor, p. ej. "PL" (Premier League). */
  competitionCode: string;
  /** Filtro de estado del proveedor, p. ej. "SCHEDULED". Opcional. */
  status?: string;
}

export type FootballDataOrgFetchOutcome =
  | {
      kind: 'response';
      status: number;
      ok: boolean;
      body: unknown;
      headers: Record<string, string>;
    }
  | { kind: 'timeout' }
  | { kind: 'network-error'; message: string };

export interface FootballDataOrgClientDeps {
  fetchFn: typeof fetch;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createFootballDataOrgClient({
  fetchFn,
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FootballDataOrgClientDeps) {
  return {
    async fetchMatches(
      params: FetchFootballDataOrgMatchesParams,
      signal?: AbortSignal,
    ): Promise<FootballDataOrgFetchOutcome> {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const url = new URL(`/v4/competitions/${params.competitionCode}/matches`, baseUrl);
      if (params.status !== undefined) {
        url.searchParams.set('status', params.status);
      }

      try {
        // X-Auth-Token es el header de autenticación de football-data.org
        // (distinto del x-apisports-key de API-Football) — confirmado en la
        // verificación real de WAT-180.
        const response = await fetchFn(url, {
          headers: { 'X-Auth-Token': apiKey },
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

        return {
          kind: 'response',
          status: response.status,
          ok: response.ok,
          body,
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
    },
  };
}
