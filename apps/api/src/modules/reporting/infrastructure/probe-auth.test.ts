import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readProbeAuthConfig,
  withProbeAccessToken,
  type ProbeAuthClient,
  type ProbeAuthClientFactory,
} from './probe-auth.js';

// Todo lo de este archivo es SIMULADO: cuentas, claves y servidor son inventados.
const SIMULATED_EMAIL = 'reporter-lectura@watchparty.test';
const SIMULATED_PASSWORD = 'SIMULATED_PASSWORD_123';
const SIMULATED_ANON_KEY = 'sb_publishable_SIMULATED_ANON_KEY';
const SIMULATED_TOKEN = 'SIMULATED.ACCESS.TOKEN';
const AUTH_URL = 'https://auth.example.test';

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwtWithRole(role: string): string {
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role })}.firma-simulada`;
}

function envFor(url: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    REPORTER_PROBE_AUTH_URL: url,
    REPORTER_PROBE_ANON_KEY: SIMULATED_ANON_KEY,
    REPORTER_PROBE_EMAIL: SIMULATED_EMAIL,
    REPORTER_PROBE_PASSWORD: SIMULATED_PASSWORD,
    ...overrides,
  };
}

describe('readProbeAuthConfig', () => {
  it('lee la configuración del ambiente', () => {
    expect(readProbeAuthConfig(envFor(AUTH_URL))).toEqual({
      ok: true,
      config: {
        url: AUTH_URL,
        anonKey: SIMULATED_ANON_KEY,
        email: SIMULATED_EMAIL,
        password: SIMULATED_PASSWORD,
      },
    });
  });

  it.each([
    ['sin URL', { REPORTER_PROBE_AUTH_URL: undefined }],
    ['sin clave anónima', { REPORTER_PROBE_ANON_KEY: undefined }],
    ['sin usuario', { REPORTER_PROBE_EMAIL: undefined }],
    ['sin contraseña', { REPORTER_PROBE_PASSWORD: undefined }],
    ['URL vacía', { REPORTER_PROBE_AUTH_URL: '  ' }],
    ['contraseña vacía', { REPORTER_PROBE_PASSWORD: '' }],
    ['contraseña de solo espacios', { REPORTER_PROBE_PASSWORD: '   ' }],
  ])('%s es config-missing', (_label, overrides) => {
    expect(readProbeAuthConfig(envFor(AUTH_URL, overrides))).toEqual({
      ok: false,
      reason: 'config-missing',
    });
  });

  it.each([
    ['texto que no es URL', { REPORTER_PROBE_AUTH_URL: 'no es una url' }],
    ['http fuera de loopback', { REPORTER_PROBE_AUTH_URL: 'http://auth.example.test' }],
    ['URL con credenciales', { REPORTER_PROBE_AUTH_URL: 'https://u:p@auth.example.test' }],
    ['URL con ruta', { REPORTER_PROBE_AUTH_URL: 'https://auth.example.test/auth/v1' }],
    ['URL con query', { REPORTER_PROBE_AUTH_URL: 'https://auth.example.test/?a=1' }],
    ['clave de rol de servicio (formato nuevo)', { REPORTER_PROBE_ANON_KEY: 'sb_secret_ABC' }],
    ['clave que es un JWT service_role', { REPORTER_PROBE_ANON_KEY: jwtWithRole('service_role') }],
    ['usuario que no es un correo', { REPORTER_PROBE_EMAIL: 'reporter' }],
  ])('%s es config-invalid', (_label, overrides) => {
    expect(readProbeAuthConfig(envFor(AUTH_URL, overrides))).toEqual({
      ok: false,
      reason: 'config-invalid',
    });
  });

  it('acepta una clave anónima legada (JWT con rol anon) y http en loopback', () => {
    const result = readProbeAuthConfig(
      envFor('http://127.0.0.1:54321', { REPORTER_PROBE_ANON_KEY: jwtWithRole('anon') }),
    );

    expect(result.ok).toBe(true);
  });

  it('usa la contraseña tal cual, sin recortarla', () => {
    const result = readProbeAuthConfig(
      envFor(AUTH_URL, { REPORTER_PROBE_PASSWORD: ' con espacios ' }),
    );

    expect(result.ok && result.config.password).toBe(' con espacios ');
  });

  it('no usa ninguna otra credencial del entorno como reemplazo', () => {
    const result = readProbeAuthConfig({
      SUPABASE_URL: AUTH_URL,
      SUPABASE_ANON_KEY: SIMULATED_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_OTRA',
      REPORTER_CENTRAL_PROJECT_KEY: 'otra-clave',
    });

    expect(result).toEqual({ ok: false, reason: 'config-missing' });
  });
});

describe('withProbeAccessToken: con un cliente simulado', () => {
  function fakeClient(options: {
    signIn?: () => Promise<{ accessToken: string } | { status: number }>;
    signOutError?: unknown;
  }) {
    const client = {
      signIn: vi.fn(options.signIn ?? (async () => ({ accessToken: SIMULATED_TOKEN }))),
      signOut: vi.fn(async () => {
        if (options.signOutError !== undefined) throw options.signOutError;
      }),
    } satisfies ProbeAuthClient;
    const createClient = vi.fn<ProbeAuthClientFactory>(() => client);

    return { client, createClient };
  }

  const env = envFor(AUTH_URL);

  it('entrega el token a `use`, devuelve su resultado y cierra la sesión al terminar', async () => {
    const { client, createClient } = fakeClient({});
    const use = vi.fn(async (token: string) => `usó ${token === SIMULATED_TOKEN}`);

    const result = await withProbeAccessToken(use, { env, createClient });

    expect(result).toEqual({ ok: true, value: 'usó true' });
    expect(use).toHaveBeenCalledWith(SIMULATED_TOKEN);
    expect(client.signOut).toHaveBeenCalledTimes(1);
  });

  it('el token no sale en el resultado: solo lo que devuelve `use`', async () => {
    const { createClient } = fakeClient({});

    const result = await withProbeAccessToken(async () => 'listo', { env, createClient });

    expect(JSON.stringify(result)).not.toContain(SIMULATED_TOKEN);
  });

  it('inicia sesión de nuevo en cada corrida: no reutiliza ni guarda tokens', async () => {
    const { client, createClient } = fakeClient({});

    await withProbeAccessToken(async () => 1, { env, createClient });
    await withProbeAccessToken(async () => 2, { env, createClient });

    expect(client.signIn).toHaveBeenCalledTimes(2);
    expect(client.signOut).toHaveBeenCalledTimes(2);
  });

  it.each<[string, NodeJS.ProcessEnv, 'config-missing' | 'config-invalid']>([
    ['sin configuración', {}, 'config-missing'],
    [
      'con configuración inválida',
      envFor(AUTH_URL, { REPORTER_PROBE_AUTH_URL: 'no es una url' }),
      'config-invalid',
    ],
  ])('%s no crea el cliente ni ejecuta el sondeo', async (_label, badEnv, reason) => {
    const { createClient } = fakeClient({});
    const use = vi.fn(async () => 1);

    const result = await withProbeAccessToken(use, { env: badEnv, createClient });

    expect(result).toEqual({ ok: false, reason });
    expect(createClient).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422])(
    'un rechazo %i de las credenciales es credentials-invalid y no ejecuta el sondeo',
    async (status) => {
      const { client, createClient } = fakeClient({ signIn: async () => ({ status }) });
      const use = vi.fn(async () => 1);

      const result = await withProbeAccessToken(use, { env, createClient });

      expect(result).toEqual({ ok: false, reason: 'credentials-invalid' });
      expect(use).not.toHaveBeenCalled();
      // Sin sesión no hay nada que cerrar.
      expect(client.signOut).not.toHaveBeenCalled();
    },
  );

  it.each([429, 500, 502, 503, 0])(
    'un %i del servicio de autenticación es auth-unavailable, no un problema de credenciales',
    async (status) => {
      const { createClient } = fakeClient({ signIn: async () => ({ status }) });

      const result = await withProbeAccessToken(async () => 1, { env, createClient });

      expect(result).toEqual({ ok: false, reason: 'auth-unavailable' });
    },
  );

  it('si el inicio de sesión lanza un error (p. ej. de red), es auth-unavailable', async () => {
    const { createClient } = fakeClient({
      signIn: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const result = await withProbeAccessToken(async () => 1, { env, createClient });

    expect(result).toEqual({ ok: false, reason: 'auth-unavailable' });
  });

  it('un fallo al cerrar la sesión no tapa el resultado del sondeo', async () => {
    const { createClient } = fakeClient({ signOutError: new Error('logout falló') });

    const result = await withProbeAccessToken(async () => 'listo', { env, createClient });

    expect(result).toEqual({ ok: true, value: 'listo' });
  });

  it('si el sondeo lanza, la sesión se cierra igual y el error se propaga', async () => {
    const { client, createClient } = fakeClient({});

    await expect(
      withProbeAccessToken(
        async () => {
          throw new Error('el sondeo falló');
        },
        { env, createClient },
      ),
    ).rejects.toThrow('el sondeo falló');
    expect(client.signOut).toHaveBeenCalledTimes(1);
  });

  it('la contraseña no aparece en el resultado aunque el error del cliente la contenga', async () => {
    const { createClient } = fakeClient({
      signIn: async () => {
        throw new Error(`login con ${SIMULATED_EMAIL} / ${SIMULATED_PASSWORD} en ${AUTH_URL}`);
      },
    });

    const result = await withProbeAccessToken(async () => 1, { env, createClient });
    const visible = JSON.stringify(result);

    for (const secret of [SIMULATED_PASSWORD, SIMULATED_EMAIL, AUTH_URL]) {
      expect(visible).not.toContain(secret);
    }
  });
});

// El cliente REAL de Supabase contra un servidor de autenticación local que imita
// los endpoints de GoTrue. Comprueba qué pide de verdad el mecanismo existente.
describe('withProbeAccessToken: con el cliente real de Supabase', () => {
  interface Recorded {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  const session = {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u-1', role: 'authenticated', exp: 4_102_444_800 })}.firma`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    refresh_token: 'refresh-simulado',
    user: { id: 'u-1', aud: 'authenticated', email: SIMULATED_EMAIL },
  };

  async function startAuthServer(
    handler: (recorded: Recorded) => { status: number; body?: unknown },
  ) {
    const requests: Recorded[] = [];
    const sockets = new Set<Socket>();

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: Recorded = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };

        requests.push(recorded);

        const { status, body } = handler(recorded);

        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      });
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const handle = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };

    servers.push(handle);

    return handle;
  }

  const acceptingServer = (password = SIMULATED_PASSWORD) =>
    startAuthServer(({ url, body }) => {
      if (url?.startsWith('/auth/v1/token')) {
        const sent = JSON.parse(body) as { password?: string };

        return sent.password === password
          ? { status: 200, body: session }
          : {
              status: 400,
              body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
            };
      }

      return { status: 204 };
    });

  it('inicia sesión con correo y contraseña (no crea usuarios) y entrega el token', async () => {
    const server = await acceptingServer();
    const use = vi.fn(async (token: string) => token);

    const result = await withProbeAccessToken(use, { env: envFor(server.url) });

    expect(result).toEqual({ ok: true, value: session.access_token });

    const login = server.requests.find((r) => r.url?.startsWith('/auth/v1/token'))!;

    expect(login.method).toBe('POST');
    expect(login.url).toContain('grant_type=password');
    expect(login.headers.apikey).toBe(SIMULATED_ANON_KEY);
    expect(JSON.parse(login.body)).toMatchObject({
      email: SIMULATED_EMAIL,
      password: SIMULATED_PASSWORD,
    });
    // Ningún alta de usuarios: es una cuenta técnica que ya existe.
    expect(server.requests.some((r) => r.url?.includes('/signup'))).toBe(false);
  });

  it('cierra solo esta sesión al terminar (scope=local), con el token recién emitido', async () => {
    const server = await acceptingServer();

    await withProbeAccessToken(async () => 'listo', { env: envFor(server.url) });

    const logout = server.requests.find((r) => r.url?.startsWith('/auth/v1/logout'))!;

    expect(logout).toBeDefined();
    expect(logout.url).toContain('scope=local');
    expect(logout.headers.authorization).toBe(`Bearer ${session.access_token}`);
  });

  it('con una contraseña incorrecta es credentials-invalid y no ejecuta el sondeo', async () => {
    const server = await acceptingServer('otra-contraseña');
    const use = vi.fn(async () => 1);

    const result = await withProbeAccessToken(use, { env: envFor(server.url) });

    expect(result).toEqual({ ok: false, reason: 'credentials-invalid' });
    expect(use).not.toHaveBeenCalled();
  });

  it('si el servicio de autenticación responde 500 es auth-unavailable', async () => {
    const server = await startAuthServer(() => ({ status: 500, body: { msg: 'boom' } }));

    const result = await withProbeAccessToken(async () => 1, { env: envFor(server.url) });

    expect(result).toEqual({ ok: false, reason: 'auth-unavailable' });
  });

  it('si el servicio de autenticación no responde es auth-unavailable', async () => {
    const server = await acceptingServer();
    const url = server.url;

    await server.close();

    const result = await withProbeAccessToken(async () => 1, { env: envFor(url) });

    expect(result).toEqual({ ok: false, reason: 'auth-unavailable' });
  });

  it('el resultado no incluye la contraseña ni el token cuando falla', async () => {
    const server = await acceptingServer('otra-contraseña');

    const result = await withProbeAccessToken(async () => 1, { env: envFor(server.url) });
    const visible = JSON.stringify(result);

    expect(visible).not.toContain(SIMULATED_PASSWORD);
    expect(visible).not.toContain(session.access_token);
  });
});

// Timeout propio de Autenticación: si Supabase Auth no responde, la colecta no
// puede quedar esperando, ni en el inicio de sesión ni al cerrarla.
describe('withProbeAccessToken: timeouts de autenticación', () => {
  const TIMEOUT_MS = 150;
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  const session = {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u-1', role: 'authenticated', exp: 4_102_444_800 })}.firma`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    refresh_token: 'refresh-simulado',
    user: { id: 'u-1', aud: 'authenticated', email: SIMULATED_EMAIL },
  };

  /** Servidor que responde el login y/o deja colgado el logout, según se pida. */
  async function startServer({ hangLogin = false, hangLogout = false } = {}) {
    const requests: string[] = [];
    const sockets = new Set<Socket>();

    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push(req.url ?? '');

        const isLogin = req.url?.startsWith('/auth/v1/token') ?? false;

        if ((isLogin && hangLogin) || (!isLogin && hangLogout)) return;

        res.writeHead(isLogin ? 200 : 204, { 'Content-Type': 'application/json' });
        res.end(isLogin ? JSON.stringify(session) : undefined);
      });
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const handle = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };

    servers.push(handle);

    return handle;
  }

  it('el inicio de sesión y el cierre salen con una señal de cancelación', async () => {
    const inits: { url: string; signal: AbortSignal | null | undefined }[] = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      inits.push({ url, signal: init?.signal });

      return url.includes('/auth/v1/token')
        ? new Response(JSON.stringify(session), { status: 200 })
        : new Response(null, { status: 204 });
    });

    const result = await withProbeAccessToken(async () => 'listo', { env: envFor(AUTH_URL) });

    expect(result).toEqual({ ok: true, value: 'listo' });
    expect(inits.map((i) => i.url.split('?')[0])).toEqual([
      `${AUTH_URL}/auth/v1/token`,
      `${AUTH_URL}/auth/v1/logout`,
    ]);

    for (const { signal } of inits) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });

  it('si Auth no responde al iniciar sesión se corta por timeout: auth-unavailable y no corre el sondeo', async () => {
    const server = await startServer({ hangLogin: true });
    const use = vi.fn(async () => 1);
    const startedAt = Date.now();

    const result = await withProbeAccessToken(use, {
      env: envFor(server.url),
      timeoutMs: TIMEOUT_MS,
    });

    expect(result).toEqual({ ok: false, reason: 'auth-unavailable' });
    expect(use).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    // Vuelve poco después del timeout: no queda esperando.
    expect(Date.now() - startedAt).toBeLessThan(TIMEOUT_MS + 2_000);
  });

  it('si Auth no responde al cerrar la sesión, el resultado del sondeo igual se devuelve', async () => {
    const server = await startServer({ hangLogout: true });
    const startedAt = Date.now();

    const result = await withProbeAccessToken(async () => 'sondeo terminado', {
      env: envFor(server.url),
      timeoutMs: TIMEOUT_MS,
    });

    expect(result).toEqual({ ok: true, value: 'sondeo terminado' });
    // El cierre sí se intentó, y se cortó por timeout.
    expect(server.requests.some((url) => url.startsWith('/auth/v1/logout'))).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(TIMEOUT_MS + 2_000);
  });

  it('un cierre colgado tampoco tapa el error del sondeo', async () => {
    const server = await startServer({ hangLogout: true });

    await expect(
      withProbeAccessToken(
        async () => {
          throw new Error('el sondeo falló');
        },
        { env: envFor(server.url), timeoutMs: TIMEOUT_MS },
      ),
    ).rejects.toThrow('el sondeo falló');
  });

  it('el motivo sigue siendo un código fijo: no expone URL, correo ni contraseña', async () => {
    const server = await startServer({ hangLogin: true });

    const result = await withProbeAccessToken(async () => 1, {
      env: envFor(server.url),
      timeoutMs: TIMEOUT_MS,
    });
    const visible = JSON.stringify(result);

    for (const secret of [SIMULATED_PASSWORD, SIMULATED_EMAIL, server.url, SIMULATED_ANON_KEY]) {
      expect(visible).not.toContain(secret);
    }
  });

  it('por defecto el timeout es de 10 s: la señal aún no venció al hacer el pedido', async () => {
    let signal: AbortSignal | null | undefined;

    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;

      return new Response(JSON.stringify(session), { status: 200 });
    });

    await withProbeAccessToken(async () => 1, { env: envFor(AUTH_URL) });

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});
