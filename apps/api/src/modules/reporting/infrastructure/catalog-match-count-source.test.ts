import net from 'node:net';
import pg from 'pg';
import { describe, it, expect, vi } from 'vitest';
import {
  CATALOG_MATCH_COUNT_UNIT,
  CatalogMatchCountSourceError,
  createPgClient,
  readCatalogMatchCount,
  readCatalogMatchCountWithLatency,
  readCatalogSourceConfig,
  type CatalogMatchCountFailureReason,
  type CatalogSqlClient,
  type CatalogSqlClientFactory,
} from './catalog-match-count-source.js';

const PASSWORD = 'p@ss/w0rd:secreta';
const VALID_URL = `postgresql://watchparty_reporter.abcdefgh:${encodeURIComponent(PASSWORD)}@db.example.test:6543/postgres?sslmode=verify-full`;
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

const NOW = new Date('2026-10-14T12:00:00Z');
const CUTOFF = new Date('2026-10-14T00:00:00Z');

const VALID_ENV = { REPORTER_DATABASE_URL: VALID_URL };

interface FakeClientOptions {
  connectError?: unknown;
  queryError?: unknown;
  rows?: unknown[];
  endError?: unknown;
}

function fakeClient(options: FakeClientOptions = {}) {
  const client = {
    connect: vi.fn(async () => {
      if (options.connectError !== undefined) throw options.connectError;
    }),
    query: vi.fn<CatalogSqlClient['query']>(async () => {
      if (options.queryError !== undefined) throw options.queryError;
      return { rows: options.rows ?? [{ value: '0' }] };
    }),
    end: vi.fn(async () => {
      if (options.endError !== undefined) throw options.endError;
    }),
  };

  return client satisfies CatalogSqlClient;
}

function sqlError(code: string, message = 'fallo') {
  return Object.assign(new Error(message), { code });
}

function read(options: FakeClientOptions = {}, env: NodeJS.ProcessEnv = VALID_ENV) {
  const client = fakeClient(options);
  const createClient = vi.fn<CatalogSqlClientFactory>(() => client);
  const result = readCatalogMatchCount(CUTOFF, { env, createClient, now: () => NOW });

  return { client, createClient, result };
}

async function failureOf(promise: Promise<unknown>): Promise<CatalogMatchCountSourceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogMatchCountSourceError);
    return error as CatalogMatchCountSourceError;
  }

  throw new Error('Debería haber fallado.');
}

function reasonOf(callback: () => unknown): CatalogMatchCountFailureReason {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogMatchCountSourceError);
    return (error as CatalogMatchCountSourceError).reason;
  }

  throw new Error('Debería haber fallado.');
}

describe('readCatalogMatchCount: consulta', () => {
  it('llama al agregado autorizado con el corte T y no lee tablas directamente', async () => {
    const { client, result } = read({ rows: [{ value: '42' }] });

    await expect(result).resolves.toEqual({ value: 42, unit: '{match}' });

    expect(client.query).toHaveBeenCalledTimes(1);

    const [sql, values] = client.query.mock.calls[0]!;

    expect(sql).toContain('reporting.catalog_match_count($1::timestamptz)');
    expect(sql).not.toMatch(/\bfrom\b/i);
    expect(values).toEqual([CUTOFF.toISOString()]);
  });

  it('la unidad es {match}', async () => {
    expect(CATALOG_MATCH_COUNT_UNIT).toBe('{match}');

    const { result } = read({ rows: [{ value: '3' }] });

    await expect(result).resolves.toMatchObject({ unit: '{match}' });
  });

  it('acepta el conteo como número y como texto (bigint del driver)', async () => {
    await expect(read({ rows: [{ value: 7 }] }).result).resolves.toMatchObject({ value: 7 });
    await expect(read({ rows: [{ value: '1234567' }] }).result).resolves.toMatchObject({
      value: 1234567,
    });
  });

  it('cero es válido cuando la consulta tuvo éxito y respondió cero', async () => {
    const { client, result } = read({ rows: [{ value: '0' }] });

    await expect(result).resolves.toEqual({ value: 0, unit: '{match}' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('abre y cierra la conexión una vez por lectura', async () => {
    const { client, result } = read();

    await result;

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('acepta un corte igual al instante actual', async () => {
    const client = fakeClient();

    await expect(
      readCatalogMatchCount(NOW, { env: VALID_ENV, createClient: () => client, now: () => NOW }),
    ).resolves.toMatchObject({ value: 0 });
  });
});

describe('readCatalogMatchCount: resultados inválidos nunca son cero', () => {
  it.each([
    ['sin filas', []],
    ['más de una fila', [{ value: '1' }, { value: '2' }]],
    ['valor nulo', [{ value: null }]],
    ['fila sin la columna', [{ otra: '1' }]],
    ['fila que no es objeto', ['1']],
    ['negativo como texto', [{ value: '-1' }]],
    ['negativo como número', [{ value: -1 }]],
    ['decimal', [{ value: '1.5' }]],
    ['notación científica', [{ value: '1e3' }]],
    ['texto no numérico', [{ value: 'abc' }]],
    ['texto vacío', [{ value: '' }]],
    ['NaN', [{ value: Number.NaN }]],
    ['Infinity', [{ value: Number.POSITIVE_INFINITY }]],
    ['fuera del rango seguro', [{ value: '9007199254740993' }]],
    ['booleano', [{ value: true }]],
  ])('%s', async (_label, rows) => {
    const { client, result } = read({ rows });
    const error = await failureOf(result);

    expect(error.reason).toBe('invalid-result');
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

describe('readCatalogMatchCount: los fallos se propagan con su motivo', () => {
  it('un fallo de conexión sin código SQL es connection-failed', async () => {
    const { result } = read({ connectError: new Error('ECONNREFUSED') });

    expect((await failureOf(result)).reason).toBe('connection-failed');
  });

  it.each([
    ['rol sin LOGIN', sqlError('28000')],
    ['contraseña rechazada', sqlError('28P01')],
  ])('%s al conectar es permission-denied', async (_label, connectError) => {
    const { client, result } = read({ connectError });

    expect((await failureOf(result)).reason).toBe('permission-denied');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('un privilegio insuficiente en la consulta es permission-denied', async () => {
    const { result } = read({ queryError: sqlError('42501') });

    expect((await failureOf(result)).reason).toBe('permission-denied');
  });

  it.each([
    ['función inexistente', sqlError('42883')],
    ['timeout de la consulta', new Error('Query read timeout')],
  ])('%s es query-failed', async (_label, queryError) => {
    const { result } = read({ queryError });

    expect((await failureOf(result)).reason).toBe('query-failed');
  });

  it('cierra la conexión aunque la consulta falle', async () => {
    const { client, result } = read({ queryError: sqlError('42883') });

    await failureOf(result);

    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('un error al cerrar no tapa el resultado ni el motivo', async () => {
    const ok = read({ rows: [{ value: '5' }], endError: new Error('socket cerrado') });
    const failed = read({ queryError: sqlError('42501'), endError: new Error('socket cerrado') });

    await expect(ok.result).resolves.toMatchObject({ value: 5 });
    expect((await failureOf(failed.result)).reason).toBe('permission-denied');
  });
});

describe('readCatalogMatchCount: corte T', () => {
  it.each([
    ['fecha inválida', new Date('no es una fecha')],
    ['fecha futura', new Date('2026-10-14T12:00:01Z')],
  ])('%s se rechaza sin abrir ninguna conexión', async (_label, cutoff) => {
    const createClient = vi.fn(() => fakeClient());

    const error = await failureOf(
      readCatalogMatchCount(cutoff, { env: VALID_ENV, createClient, now: () => NOW }),
    );

    expect(error.reason).toBe('invalid-cutoff');
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('readCatalogMatchCount: ausencia segura de credencial', () => {
  it.each([
    ['sin la variable', {}],
    ['variable vacía', { REPORTER_DATABASE_URL: '' }],
    ['solo espacios', { REPORTER_DATABASE_URL: '   ' }],
  ])('%s falla con config-missing sin abrir ninguna conexión', async (_label, env) => {
    const { createClient, result } = read({}, env);

    expect((await failureOf(result)).reason).toBe('config-missing');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('no usa otras credenciales del entorno como reemplazo', async () => {
    const env = {
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      SUPABASE_URL: 'https://x.supabase.co',
      DATABASE_URL: 'postgresql://postgres:otra@host/postgres',
      PGPASSWORD: 'otra',
    };
    const { createClient, result } = read({}, env);

    expect((await failureOf(result)).reason).toBe('config-missing');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('una configuración inválida tampoco abre ninguna conexión', async () => {
    const { createClient, result } = read({}, { REPORTER_DATABASE_URL: 'esto no es una url' });

    expect((await failureOf(result)).reason).toBe('config-invalid');
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('readCatalogMatchCount: no filtra secretos', () => {
  it('el error no incluye la contraseña, la URL ni el mensaje del driver', async () => {
    const driverMessage = `password authentication failed for user "watchparty_reporter" (${PASSWORD}) en ${VALID_URL}`;
    const { result } = read({ connectError: sqlError('28P01', driverMessage) });

    const error = await failureOf(result);
    const visible = [error.message, String(error), JSON.stringify(error), error.stack ?? ''].join(
      '\n',
    );

    for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), 'db.example.test', VALID_URL]) {
      expect(visible).not.toContain(secret);
    }

    expect(error.cause).toBeUndefined();
  });

  it('los errores de configuración no incluyen la URL', () => {
    const rawUrl = `postgresql://postgres:${PASSWORD}@db.example.test/postgres?sslmode=verify-full`;

    try {
      readCatalogSourceConfig({ REPORTER_DATABASE_URL: rawUrl });
    } catch (error) {
      const visible = `${(error as Error).message}${String(error)}${JSON.stringify(error)}`;

      expect(visible).not.toContain(PASSWORD);
      expect(visible).not.toContain('db.example.test');
      return;
    }

    throw new Error('Debería haber fallado.');
  });
});

describe('readCatalogSourceConfig', () => {
  it('arma la conexión con campos explícitos y decodifica la contraseña', () => {
    expect(readCatalogSourceConfig(VALID_ENV)).toEqual({
      host: 'db.example.test',
      port: 6543,
      user: 'watchparty_reporter.abcdefgh',
      password: PASSWORD,
      database: 'postgres',
    });
  });

  it('usa el puerto 5432 si la URL no trae uno', () => {
    const env = {
      REPORTER_DATABASE_URL:
        'postgres://watchparty_reporter:clave@db.example.test/postgres?sslmode=verify-full',
    };

    expect(readCatalogSourceConfig(env)).toMatchObject({ port: 5432 });
  });

  it('toma la CA opcional de REPORTER_DATABASE_CA_CERT', () => {
    const config = readCatalogSourceConfig({
      ...VALID_ENV,
      REPORTER_DATABASE_CA_CERT: ` ${CA_PEM} `,
    });

    expect(config.ca).toBe(CA_PEM);
  });

  it.each([
    ['sin sslmode', 'postgresql://watchparty_reporter:clave@db.example.test/postgres'],
    [
      'sslmode=disable',
      'postgresql://watchparty_reporter:clave@db.example.test/postgres?sslmode=disable',
    ],
    [
      'sslmode=prefer',
      'postgresql://watchparty_reporter:clave@db.example.test/postgres?sslmode=prefer',
    ],
    [
      'sslmode=require',
      'postgresql://watchparty_reporter:clave@db.example.test/postgres?sslmode=require',
    ],
    [
      'sslmode=verify-ca',
      'postgresql://watchparty_reporter:clave@db.example.test/postgres?sslmode=verify-ca',
    ],
    [
      'sslmode=no-verify',
      'postgresql://watchparty_reporter:clave@db.example.test/postgres?sslmode=no-verify',
    ],
    [
      'protocolo que no es postgres',
      'https://watchparty_reporter:clave@db.example.test/postgres?sslmode=verify-full',
    ],
    ['sin usuario', 'postgresql://:clave@db.example.test/postgres?sslmode=verify-full'],
    [
      'sin contraseña',
      'postgresql://watchparty_reporter@db.example.test/postgres?sslmode=verify-full',
    ],
    ['sin base', 'postgresql://watchparty_reporter:clave@db.example.test?sslmode=verify-full'],
    [
      'puerto inválido',
      'postgresql://watchparty_reporter:clave@db.example.test:99999/postgres?sslmode=verify-full',
    ],
    ['texto que no es URL', 'esto no es una url'],
  ])('rechaza la URL: %s', (_label, REPORTER_DATABASE_URL) => {
    expect(reasonOf(() => readCatalogSourceConfig({ REPORTER_DATABASE_URL }))).toBe(
      'config-invalid',
    );
  });

  it.each([
    'postgres',
    'postgres.abcdefgh',
    'service_role',
    'service_role.abcdefgh',
    'supabase_admin',
    'POSTGRES',
  ])('rechaza el usuario administrativo o central: %s', (user) => {
    const REPORTER_DATABASE_URL = `postgresql://${user}:clave@db.example.test/postgres?sslmode=verify-full`;

    expect(reasonOf(() => readCatalogSourceConfig({ REPORTER_DATABASE_URL }))).toBe(
      'config-invalid',
    );
  });

  it('rechaza una CA que no es un certificado PEM', () => {
    expect(
      reasonOf(() =>
        readCatalogSourceConfig({
          ...VALID_ENV,
          REPORTER_DATABASE_CA_CERT: 'no soy un certificado',
        }),
      ),
    ).toBe('config-invalid');
  });
});

/**
 * Reemplaza `pg.Client` por una función que arma un cliente REAL (sin conectar)
 * y guarda la configuración y la instancia. `override` permite apuntarlo a otro
 * destino. Siempre hay que llamar a `restore`.
 */
function spyOnPgClient(override?: (config: pg.ClientConfig) => pg.ClientConfig) {
  const RealClient = pg.Client;
  const configs: pg.ClientConfig[] = [];
  const clients: pg.Client[] = [];

  const spy = vi.spyOn(pg, 'Client').mockImplementation(function (config: pg.ClientConfig) {
    configs.push(config);

    const client = new RealClient(override ? override(config) : config);

    clients.push(client);

    return client;
  } as never);

  return { configs, clients, restore: () => spy.mockRestore() };
}

describe('createPgClient', () => {
  it('exige TLS con verificación del servidor y no conecta al crearse', () => {
    const config = readCatalogSourceConfig({ ...VALID_ENV, REPORTER_DATABASE_CA_CERT: CA_PEM });
    const spied = spyOnPgClient();

    try {
      const client = createPgClient(config);

      expect(spied.configs).toHaveLength(1);
      expect(spied.configs[0]).toMatchObject({
        host: 'db.example.test',
        port: 6543,
        user: 'watchparty_reporter.abcdefgh',
        database: 'postgres',
        ssl: { rejectUnauthorized: true, ca: CA_PEM },
      });
      expect(client).toEqual({
        connect: expect.any(Function),
        query: expect.any(Function),
        end: expect.any(Function),
      });
    } finally {
      spied.restore();
    }
  });

  it('sin CA propia verifica igual contra el almacén de confianza del sistema', () => {
    const spied = spyOnPgClient();

    try {
      createPgClient(readCatalogSourceConfig(VALID_ENV));

      expect(spied.configs[0]).toMatchObject({ ssl: { rejectUnauthorized: true } });
    } finally {
      spied.restore();
    }
  });
});

// Desconexión con el driver `pg` real. Servidor mínimo del protocolo de Postgres
// que completa el arranque y corta la conexión cuando llega la consulta, como lo
// haría una caída de red o el reinicio de un pooler. La conexión es local y sin
// TLS solo en este test: el TLS verificado ya lo prueba `createPgClient` arriba.
describe('createPgClient: desconexión con el driver real', () => {
  const AUTHENTICATION_OK_AND_READY = Buffer.from([
    0x52,
    0,
    0,
    0,
    8,
    0,
    0,
    0,
    0, // AuthenticationOk
    0x5a,
    0,
    0,
    0,
    5,
    0x49, // ReadyForQuery
  ]);

  async function startServerThatDropsOnQuery() {
    const server = net.createServer((socket) => {
      let started = false;

      socket.on('error', () => {});
      socket.on('data', () => {
        if (!started) {
          started = true;
          socket.write(AUTHENTICATION_OK_AND_READY);
          return;
        }

        socket.destroy();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const toLocalServer = (port: number) => (config: pg.ClientConfig) => ({
    ...config,
    host: '127.0.0.1',
    port,
    ssl: false,
  });

  it('una conexión que se corta durante la consulta se omite con motivo y no tira el proceso', async () => {
    const server = await startServerThatDropsOnQuery();
    const spied = spyOnPgClient(toLocalServer(server.port));

    try {
      const error = await failureOf(
        readCatalogMatchCount(CUTOFF, { env: VALID_ENV, now: () => NOW }),
      );

      // El fallo sigue propagándose por la promesa, con un motivo controlado.
      expect(error.reason).toBe('query-failed');
      expect(spied.clients).toHaveLength(1);
      // El driver emitió su evento `error`: sin listener habría terminado el proceso.
      expect(spied.clients[0]!.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      spied.restore();
      await server.close();
    }
  });

  it('registra el listener de error al crear el cliente, antes de conectar', () => {
    const spied = spyOnPgClient();

    try {
      createPgClient(readCatalogSourceConfig(VALID_ENV));

      const client = spied.clients[0]!;

      expect(client.listenerCount('error')).toBeGreaterThan(0);
      // Un evento `error` suelto (conexión ociosa que se pierde) ya no tira el proceso.
      expect(() =>
        client.emit('error', new Error('Connection terminated unexpectedly')),
      ).not.toThrow();
    } finally {
      spied.restore();
    }
  });
});

// Latencia de la consulta del catálogo (`catalog_query_latency`): la misma consulta
// real del conteo, medida con un reloj monotónico controlado por el test.
describe('readCatalogMatchCountWithLatency: latencia de la consulta', () => {
  interface TimedOptions extends FakeClientOptions {
    connectMs?: number;
    queryMs?: number;
  }

  /** Cliente cuyas operaciones hacen avanzar un reloj monotónico controlado. */
  function timed(options: TimedOptions = {}) {
    const clock = { ms: 1_000 };
    const client = fakeClient(options);

    client.connect.mockImplementation(async () => {
      clock.ms += options.connectMs ?? 0;
      if (options.connectError !== undefined) throw options.connectError;
    });
    client.query.mockImplementation(async () => {
      clock.ms += options.queryMs ?? 0;
      if (options.queryError !== undefined) throw options.queryError;
      return { rows: options.rows ?? [{ value: '12' }] };
    });

    const createClient = vi.fn<CatalogSqlClientFactory>(() => client);
    const result = readCatalogMatchCountWithLatency(CUTOFF, {
      env: VALID_ENV,
      createClient,
      now: () => NOW,
      monotonicMs: () => clock.ms,
    });

    return { client, createClient, clock, result };
  }

  it('mide una duración conocida con el reloj monotónico, junto con el conteo', async () => {
    const { result } = timed({ queryMs: 42 });

    await expect(result).resolves.toEqual({
      count: { value: 12, unit: '{match}' },
      queryDurationMs: 42,
    });
  });

  it('mide hasta recibir el resultado y no incluye el tiempo de conexión', async () => {
    const { result } = timed({ connectMs: 800, queryMs: 42 });

    expect((await result).queryDurationMs).toBe(42);
  });

  it('una consulta instantánea da 0, que es una latencia válida', async () => {
    const { result } = timed({ queryMs: 0 });

    expect((await result).queryDurationMs).toBe(0);
  });

  it('reutiliza la consulta real del conteo: una sola consulta, la misma, al corte T', async () => {
    const { client, result } = timed({ queryMs: 5 });

    await result;

    expect(client.query).toHaveBeenCalledTimes(1);

    const [sql, values] = client.query.mock.calls[0]!;

    expect(sql).toContain('reporting.catalog_match_count($1::timestamptz)');
    expect(sql).not.toMatch(/\bfrom\b/i);
    expect(values).toEqual([CUTOFF.toISOString()]);
  });

  it('no depende del reloj de pared: solo del monotónico', async () => {
    const clock = { ms: 0 };
    const client = fakeClient({ rows: [{ value: '3' }] });

    client.query.mockImplementation(async () => {
      clock.ms += 7;
      return { rows: [{ value: '3' }] };
    });

    // El reloj de pared salta hacia atrás: no cambia la duración.
    const wall = [NOW, new Date(NOW.getTime() - 3_600_000)];

    const result = await readCatalogMatchCountWithLatency(CUTOFF, {
      env: VALID_ENV,
      createClient: () => client,
      now: () => wall.shift() ?? NOW,
      monotonicMs: () => clock.ms,
    });

    expect(result.queryDurationMs).toBe(7);
  });

  it('sin reloj inyectado usa uno monotónico real: la duración es finita y no negativa', async () => {
    const client = fakeClient({ rows: [{ value: '1' }] });

    const result = await readCatalogMatchCountWithLatency(CUTOFF, {
      env: VALID_ENV,
      createClient: () => client,
      now: () => NOW,
    });

    expect(Number.isFinite(result.queryDurationMs)).toBe(true);
    expect(result.queryDurationMs).toBeGreaterThanOrEqual(0);
  });

  it.each<[string, TimedOptions, CatalogMatchCountFailureReason]>([
    ['la consulta falla', { queryError: sqlError('42883'), queryMs: 10 }, 'query-failed'],
    [
      'la consulta no tiene permiso',
      { queryError: sqlError('42501'), queryMs: 10 },
      'permission-denied',
    ],
    ['la conexión falla', { connectError: new Error('ECONNREFUSED') }, 'connection-failed'],
    [
      'la conexión es rechazada por permisos',
      { connectError: sqlError('28P01') },
      'permission-denied',
    ],
    ['el resultado es inválido', { rows: [{ value: null }], queryMs: 10 }, 'invalid-result'],
    ['el resultado viene vacío', { rows: [], queryMs: 10 }, 'invalid-result'],
  ])(
    'si %s no hay latencia: se lanza el motivo y no se informa ninguna duración',
    async (_label, options, reason) => {
      const { client, result } = timed(options);
      const error = await failureOf(result);

      expect(error.reason).toBe(reason);
      expect(client.end).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['sin configuración', {}, 'config-missing'],
    ['con configuración inválida', { REPORTER_DATABASE_URL: 'no es una url' }, 'config-invalid'],
  ] as const)('%s no abre ninguna conexión ni mide nada', async (_label, env, reason) => {
    const createClient = vi.fn<CatalogSqlClientFactory>(() => fakeClient());
    const monotonicMs = vi.fn(() => 0);

    const error = await failureOf(
      readCatalogMatchCountWithLatency(CUTOFF, { env, createClient, now: () => NOW, monotonicMs }),
    );

    expect(error.reason).toBe(reason);
    expect(createClient).not.toHaveBeenCalled();
    expect(monotonicMs).not.toHaveBeenCalled();
  });

  it('un corte inválido o futuro no abre ninguna conexión', async () => {
    const createClient = vi.fn<CatalogSqlClientFactory>(() => fakeClient());

    const error = await failureOf(
      readCatalogMatchCountWithLatency(new Date(NOW.getTime() + 1), {
        env: VALID_ENV,
        createClient,
        now: () => NOW,
      }),
    );

    expect(error.reason).toBe('invalid-cutoff');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('el error no incluye credenciales ni host: la latencia usa el mismo aislamiento', async () => {
    const message = `fallo en postgresql://watchparty_reporter:${PASSWORD}@db.example.test/postgres`;
    const { result } = timed({ queryError: sqlError('XX000', message), queryMs: 3 });

    const error = await failureOf(result);
    const visible = `${error.message}${String(error)}${JSON.stringify(error)}${error.stack ?? ''}`;

    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain('db.example.test');
  });
});

describe('readCatalogMatchCount: el conteo existente no cambia con la latencia', () => {
  it('devuelve solo el conteo y su unidad, igual que antes', async () => {
    const client = fakeClient({ rows: [{ value: '42' }] });

    await expect(
      readCatalogMatchCount(CUTOFF, { env: VALID_ENV, createClient: () => client, now: () => NOW }),
    ).resolves.toEqual({ value: 42, unit: '{match}' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('cuenta lo mismo que la lectura con latencia', async () => {
    const rows = [{ value: '7' }];
    const deps = { env: VALID_ENV, now: () => NOW };

    const solo = await readCatalogMatchCount(CUTOFF, {
      ...deps,
      createClient: () => fakeClient({ rows }),
    });
    const conLatencia = await readCatalogMatchCountWithLatency(CUTOFF, {
      ...deps,
      createClient: () => fakeClient({ rows }),
    });

    expect(conLatencia.count).toEqual(solo);
  });
});
