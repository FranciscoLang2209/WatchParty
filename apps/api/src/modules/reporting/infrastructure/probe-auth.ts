import { createClient } from '@supabase/supabase-js';
import { isLoopbackHost, looksLikeServiceRoleKey } from './central-measurement-publisher.js';

/** Proyecto Supabase de WatchParty donde vive la cuenta técnica (no la plataforma central). */
const AUTH_URL_VAR = 'REPORTER_PROBE_AUTH_URL';
/** Clave anónima (publicable) de ese proyecto: es pública, como la que usa la web. */
const ANON_KEY_VAR = 'REPORTER_PROBE_ANON_KEY';
const EMAIL_VAR = 'REPORTER_PROBE_EMAIL';
const PASSWORD_VAR = 'REPORTER_PROBE_PASSWORD';

/** Motivos por los que no se pudo obtener el token. Códigos fijos, nunca texto de Supabase. */
export type ProbeAuthFailureReason =
  'config-missing' | 'config-invalid' | 'credentials-invalid' | 'auth-unavailable';

export interface ProbeAuthConfig {
  url: string;
  anonKey: string;
  email: string;
  /** Es un secreto: no se loguea ni se serializa. */
  password: string;
}

type ProbeAuthConfigResult =
  | { ok: true; config: ProbeAuthConfig }
  | { ok: false; reason: 'config-missing' | 'config-invalid' };

/**
 * Lee, por ambiente, la configuración de la cuenta técnica de lectura. Sin valor
 * por defecto: si falta algo no hay sondeo. La URL debe ser https (http solo en
 * loopback, para pruebas), y la clave no puede ser de rol de servicio.
 */
export function readProbeAuthConfig(env: NodeJS.ProcessEnv = process.env): ProbeAuthConfigResult {
  const rawUrl = env[AUTH_URL_VAR]?.trim();
  const anonKey = env[ANON_KEY_VAR]?.trim();
  const email = env[EMAIL_VAR]?.trim();
  // La contraseña se usa tal cual: recortarla la cambiaría.
  const password = env[PASSWORD_VAR];

  if (!rawUrl || !anonKey || !email || !password || password.trim() === '') {
    return { ok: false, reason: 'config-missing' };
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    // No se propaga el error original: su mensaje incluye la URL.
    return { ok: false, reason: 'config-invalid' };
  }

  const secureEnough =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));

  if (
    !secureEnough ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    looksLikeServiceRoleKey(anonKey) ||
    !/^[^\s@]+@[^\s@]+$/.test(email)
  ) {
    return { ok: false, reason: 'config-invalid' };
  }

  return { ok: true, config: { url: url.origin, anonKey, email, password } };
}

/** Lo mínimo del cliente de autenticación: permite probar sin red. */
export interface ProbeAuthClient {
  /** El access token, o el estado HTTP del rechazo (0 si no hubo respuesta utilizable). */
  signIn(): Promise<{ accessToken: string } | { status: number }>;
  signOut(): Promise<void>;
}

export type ProbeAuthClientFactory = (config: ProbeAuthConfig) => ProbeAuthClient;

/** Tiempo máximo de cada pedido a Supabase Auth (inicio y cierre de sesión). */
export const PROBE_AUTH_TIMEOUT_MS = 10_000;

/**
 * `fetch` con un tiempo máximo por pedido. El SDK de Supabase no lo pone: si Auth
 * deja de responder, sin esto el inicio de sesión (y el cierre) esperarían para
 * siempre y con ellos toda la colecta. Cancelar hace que el SDK devuelva un error
 * sin respuesta (estado 0), que acá se informa como `auth-unavailable`.
 */
function fetchWithTimeout(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    return fetch(input, { ...init, signal });
  };
}

/**
 * Cliente de Supabase Auth con las mismas opciones que usa la API para verificar
 * tokens: sin sesión persistida, sin renovación automática y sin clave elevada.
 * Inicia sesión con una cuenta existente; no crea usuarios. Todos sus pedidos
 * tienen un tiempo máximo.
 */
export function createProbeAuthClient(
  config: ProbeAuthConfig,
  { timeoutMs = PROBE_AUTH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): ProbeAuthClient {
  const client = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchWithTimeout(timeoutMs) },
  });

  return {
    signIn: async () => {
      const { data, error } = await client.auth.signInWithPassword({
        email: config.email,
        password: config.password,
      });

      if (error) return { status: error.status ?? 0 };

      const accessToken = data.session?.access_token;

      return typeof accessToken === 'string' && accessToken !== ''
        ? { accessToken }
        : { status: 0 };
    },
    // `local` revoca solo esta sesión: no cierra otras de la misma cuenta.
    signOut: async () => {
      await client.auth.signOut({ scope: 'local' });
    },
  };
}

// Supabase rechaza credenciales con 400 (la mayoría), 401, 403 o 422. Un 429, un
// 5xx o la falta de respuesta son un problema del servicio de autenticación o de
// la red, no de las credenciales.
const REJECTED_CREDENTIALS_STATUSES = [400, 401, 403, 422];

export type ProbeTokenRun<T> =
  { ok: true; value: T } | { ok: false; reason: ProbeAuthFailureReason };

export interface ProbeAuthDeps {
  env?: NodeJS.ProcessEnv;
  createClient?: ProbeAuthClientFactory;
  /** Tiempo máximo de cada pedido a Auth; solo aplica al cliente real. */
  timeoutMs?: number;
}

/**
 * Inicia sesión con la cuenta técnica de lectura, entrega el access token a
 * `use` y cierra la sesión al terminar. El token nunca sale de esta función: no
 * se devuelve, no se guarda ni se imprime, y vive solo lo que dura el sondeo. Se
 * obtiene uno nuevo en cada corrida, así no hace falta renovarlo.
 *
 * Un fallo de configuración, de credenciales o del servicio de autenticación se
 * informa con un motivo fijo y `use` no se ejecuta.
 */
export async function withProbeAccessToken<T>(
  use: (accessToken: string) => Promise<T>,
  {
    env = process.env,
    timeoutMs,
    createClient: createAuthClient = (config) => createProbeAuthClient(config, { timeoutMs }),
  }: ProbeAuthDeps = {},
): Promise<ProbeTokenRun<T>> {
  const configured = readProbeAuthConfig(env);

  if (!configured.ok) {
    return { ok: false, reason: configured.reason };
  }

  const client = createAuthClient(configured.config);
  let signedIn: Awaited<ReturnType<ProbeAuthClient['signIn']>>;

  try {
    signedIn = await client.signIn();
  } catch {
    return { ok: false, reason: 'auth-unavailable' };
  }

  if ('status' in signedIn) {
    return {
      ok: false,
      reason: REJECTED_CREDENTIALS_STATUSES.includes(signedIn.status)
        ? 'credentials-invalid'
        : 'auth-unavailable',
    };
  }

  try {
    return { ok: true, value: await use(signedIn.accessToken) };
  } finally {
    try {
      await client.signOut();
    } catch {
      // Cerrar sesión es best-effort: no debe tapar el resultado del sondeo.
    }
  }
}
