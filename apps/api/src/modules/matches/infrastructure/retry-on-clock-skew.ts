/**
 * PostgREST rechaza con `401 PGRST303` («JWT issued at future») un token cuya
 * fecha de emisión queda apenas adelante de su propio reloj. Es una diferencia
 * de reloj entre servidores de Supabase que dura instantes: el mismo pedido,
 * repetido un momento después, se acepta (WAT-283).
 *
 * Reintentar es seguro para cualquier método: PostgREST valida el JWT antes de
 * ejecutar nada, así que el pedido rechazado no tuvo efecto.
 */
export const CLOCK_SKEW_RETRY_DELAY_MS = 1000;

const CLOCK_SKEW_CODE = 'PGRST303';

interface RetryOnClockSkewOptions {
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function isClockSkew(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;

  try {
    // Se lee una copia: la respuesta original sigue intacta para quien la use.
    const body: unknown = await response.clone().json();
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as { code?: unknown }).code === CLOCK_SKEW_CODE
    );
  } catch {
    return false;
  }
}

/**
 * Envuelve `fetch` para reintentar **una sola vez** ante `PGRST303`. Si el
 * reintento también falla, se devuelve ese error: no hay bucle.
 */
export function retryOnClockSkew(
  baseFetch: typeof fetch = fetch,
  { delayMs = CLOCK_SKEW_RETRY_DELAY_MS, sleep = defaultSleep }: RetryOnClockSkewOptions = {},
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);

    if (!(await isClockSkew(response))) return response;

    await sleep(delayMs);

    return baseFetch(input, init);
  };
}
