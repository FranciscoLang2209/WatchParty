import net from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogMatchCountSourceError,
  type CatalogSqlClient,
  type CatalogSqlClientFactory,
} from './catalog-match-count-source.js';
import { probeDatabaseAvailability } from './database-availability-probe.js';

// Todo lo de este archivo es SIMULADO: claves, hosts y servidor son inventados.
const PASSWORD = 'p@ss/w0rd:secreta';
const VALID_URL = `postgresql://watchparty_reporter.abcdefgh:${encodeURIComponent(PASSWORD)}@db.example.test:6543/postgres?sslmode=verify-full`;
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
      return { rows: options.rows ?? [{ ok: 1 }] };
    }),
    end: vi.fn(async () => {
      if (options.endError !== undefined) throw options.endError;
    }),
  };

  return client satisfies CatalogSqlClient;
}

/** Error de la base: lleva un SQLSTATE en `code`. */
function sqlError(code: string, message = 'fallo') {
  return Object.assign(new Error(message), { code });
}

/** Error de red de Node: lleva su código (`ECONNREFUSED`, `ENOTFOUND`...). */
function nodeError(code: string, message = 'fallo de red') {
  return Object.assign(new Error(message), { code });
}

function probe(options: FakeClientOptions = {}, env: NodeJS.ProcessEnv = VALID_ENV) {
  const client = fakeClient(options);
  const createClient = vi.fn<CatalogSqlClientFactory>(() => client);
  const result = probeDatabaseAvailability({ env, createClient });

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeDatabaseAvailability: éxito', () => {
  it('devuelve 1 cuando la lectura mínima termina bien', async () => {
    const { result } = probe();

    await expect(result).resolves.toBe(1);
  });

  it('la lectura es un select 1: no nombra tablas ni funciones, así que no pide permisos', async () => {
    const { client, result } = probe();

    await result;

    expect(client.query).toHaveBeenCalledTimes(1);

    const [sql, values] = client.query.mock.calls[0]!;

    expect(sql).toBe('select 1 as ok');
    expect(sql).not.toMatch(/\bfrom\b|reporting\.|matches|rooms|profiles/i);
    expect(values).toEqual([]);
  });

  it('abre y cierra su propia conexión una vez', async () => {
    const { client, createClient, result } = probe();

    await result;

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('no usa /health ni ninguna petición HTTP: la base se consulta directamente', async () => {
    const fetchFn = vi.fn(async () => new Response('{}'));

    vi.stubGlobal('fetch', fetchFn);

    await probe().result;

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('no depende de la función del catálogo: funciona aunque esa función no exista', async () => {
    // El cliente solo contesta la lectura mínima; cualquier otra consulta fallaría.
    const client = fakeClient();

    client.query.mockImplementation(async (text) => {
      if (text !== 'select 1 as ok') throw sqlError('42883');

      return { rows: [{ ok: 1 }] };
    });

    await expect(
      probeDatabaseAvailability({ env: VALID_ENV, createClient: () => client }),
    ).resolves.toBe(1);
  });
});

describe('probeDatabaseAvailability: indisponibilidad comprobada = 0', () => {
  it.each([
    ['57P01', 'apagada por el administrador'],
    ['57P02', 'caída'],
    ['57P03', 'todavía no acepta conexiones'],
    ['53300', 'sin cupo de conexiones'],
    ['08006', 'conexión perdida'],
  ])('si la base informa %s (%s) al conectar, es 0', async (code) => {
    const { client, result } = probe({ connectError: sqlError(code) });

    await expect(result).resolves.toBe(0);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it.each(['57P01', '57P02', '57P03', '53300', '08006'])(
    'si la base informa %s durante la lectura, es 0',
    async (code) => {
      const { result } = probe({ queryError: sqlError(code) });

      await expect(result).resolves.toBe(0);
    },
  );

  it.each(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'])(
    'un corte (%s) con la sesión ya autenticada prueba que la base falló: es 0',
    async (code) => {
      const { client, result } = probe({ queryError: nodeError(code) });

      await expect(result).resolves.toBe(0);
      expect(client.connect).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['Connection terminated unexpectedly'],
    ['Query read timeout'],
    ['Client has encountered a connection error and is not queryable'],
  ])('si ya autenticado deja de responder o corta (%s), es 0', async (message) => {
    const { client, result } = probe({ queryError: new Error(message) });

    await expect(result).resolves.toBe(0);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('un 0 no lanza ni deja valores intermedios: es un desenlace normal', async () => {
    const { client, result } = probe({ connectError: sqlError('57P03') });

    await expect(result).resolves.toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('probeDatabaseAvailability: se omite con motivo, nunca 0', () => {
  it.each([
    ['28P01', 'contraseña rechazada'],
    ['28000', 'rol sin LOGIN'],
    ['28P02', 'autorización inválida'],
  ])('un rechazo de acceso al conectar (%s, %s) es permission-denied', async (code) => {
    const { client, result } = probe({ connectError: sqlError(code) });

    expect((await failureOf(result)).reason).toBe('permission-denied');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('un privilegio insuficiente durante la lectura es permission-denied', async () => {
    const { result } = probe({ queryError: sqlError('42501') });

    expect((await failureOf(result)).reason).toBe('permission-denied');
  });

  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])(
    'un fallo de certificado o TLS (%s) es de la configuración: connection-failed',
    async (code) => {
      const { result } = probe({ connectError: nodeError(code) });

      expect((await failureOf(result)).reason).toBe('connection-failed');
    },
  );

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'])(
    'un fallo de DNS o de ruta (%s) no prueba una caída: connection-failed',
    async (code) => {
      const { result } = probe({ connectError: nodeError(code) });

      expect((await failureOf(result)).reason).toBe('connection-failed');
    },
  );

  // Antes de autenticar no hay ninguna respuesta de la base: un puerto equivocado o un
  // firewall dan exactamente el mismo error que una base caída.
  it.each(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'])(
    'un rechazo o corte (%s) ANTES de autenticar no prueba una caída: connection-failed',
    async (code) => {
      const { client, result } = probe({ connectError: nodeError(code) });

      expect((await failureOf(result)).reason).toBe('connection-failed');
      expect(client.query).not.toHaveBeenCalled();
      expect(client.end).toHaveBeenCalledTimes(1);
    },
  );

  it('un tiempo agotado al conectar no se distingue de un problema de red del reporter', async () => {
    const { result } = probe({
      connectError: new Error('Connection terminated due to connection timeout'),
    });

    expect((await failureOf(result)).reason).toBe('connection-failed');
  });

  it.each(['42601', 'XX000', '42883'])(
    'otro error de SQL (%s) con la base atendiendo es query-failed, no una caída',
    async (code) => {
      const { result } = probe({ queryError: sqlError(code) });

      expect((await failureOf(result)).reason).toBe('query-failed');
    },
  );

  it.each([
    ['sin filas', []],
    ['más de una fila', [{ ok: 1 }, { ok: 1 }]],
    ['un valor distinto de 1', [{ ok: 2 }]],
    ['un valor como texto', [{ ok: '1' }]],
    ['un valor nulo', [{ ok: null }]],
    ['una fila sin la columna', [{}]],
  ])('un resultado inválido (%s) es invalid-result', async (_label, rows) => {
    const { client, result } = probe({ rows });

    expect((await failureOf(result)).reason).toBe('invalid-result');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('un error al cerrar la conexión no tapa el resultado ni el motivo', async () => {
    const ok = probe({ endError: new Error('socket cerrado') });
    const down = probe({ connectError: sqlError('57P01'), endError: new Error('x') });
    const denied = probe({ connectError: sqlError('28P01'), endError: new Error('x') });

    await expect(ok.result).resolves.toBe(1);
    await expect(down.result).resolves.toBe(0);
    expect((await failureOf(denied.result)).reason).toBe('permission-denied');
  });
});

describe('probeDatabaseAvailability: configuración', () => {
  it.each([
    ['sin REPORTER_DATABASE_URL', {}, 'config-missing'],
    ['con una URL vacía', { REPORTER_DATABASE_URL: '  ' }, 'config-missing'],
    ['con una URL inválida', { REPORTER_DATABASE_URL: 'no es una url' }, 'config-invalid'],
    [
      'sin sslmode=verify-full',
      { REPORTER_DATABASE_URL: 'postgresql://watchparty_reporter:clave@db.example.test/postgres' },
      'config-invalid',
    ],
    [
      'con un usuario administrativo',
      {
        REPORTER_DATABASE_URL:
          'postgresql://postgres:clave@db.example.test/postgres?sslmode=verify-full',
      },
      'config-invalid',
    ],
    [
      'con el rol de servicio',
      {
        REPORTER_DATABASE_URL:
          'postgresql://service_role:clave@db.example.test/postgres?sslmode=verify-full',
      },
      'config-invalid',
    ],
  ])('%s se omite (%s) y no abre ninguna conexión', async (_label, env, reason) => {
    const createClient = vi.fn<CatalogSqlClientFactory>(() => fakeClient());

    const error = await failureOf(probeDatabaseAvailability({ env, createClient }));

    expect(error.reason).toBe(reason);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('no usa otras credenciales del entorno como reemplazo', async () => {
    const createClient = vi.fn<CatalogSqlClientFactory>(() => fakeClient());

    const error = await failureOf(
      probeDatabaseAvailability({
        env: {
          SUPABASE_URL: 'https://propio.example.test',
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_OTRA',
          DATABASE_URL: 'postgresql://postgres:otra@host/postgres',
          PGPASSWORD: 'otra',
        },
        createClient,
      }),
    );

    expect(error.reason).toBe('config-missing');
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('probeDatabaseAvailability: no filtra credenciales', () => {
  const LEAKY = `fallo en ${VALID_URL} con la contraseña ${PASSWORD}`;

  it.each([
    ['permisos', { connectError: sqlError('28P01', LEAKY) }],
    ['red', { connectError: nodeError('ENOTFOUND', LEAKY) }],
    ['certificado', { connectError: nodeError('CERT_HAS_EXPIRED', LEAKY) }],
    ['consulta', { queryError: sqlError('XX000', LEAKY) }],
  ] as const)(
    'el motivo de un fallo de %s no incluye contraseña, host ni URL',
    async (_label, options) => {
      const { result } = probe(options);

      const error = await failureOf(result);
      const visible = `${error.message}${String(error)}${JSON.stringify(error)}${error.stack ?? ''}`;

      for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), 'db.example.test', VALID_URL]) {
        expect(visible).not.toContain(secret);
      }

      expect(error.cause).toBeUndefined();
    },
  );
});

// El driver `pg` REAL contra un servidor mínimo del protocolo de Postgres. La
// conexión es local y sin TLS solo en este test: el TLS verificado ya lo prueba
// `createPgClient` en sus propios tests.
describe('probeDatabaseAvailability: con el driver real', () => {
  type Mode = 'ok' | 'drop-on-startup' | 'drop-on-query' | 'shutdown' | 'reject-auth';

  /** Mensaje del protocolo: tipo, longitud (incluye los 4 bytes propios) y contenido. */
  function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(5);

    header.write(type, 0, 'latin1');
    header.writeInt32BE(body.length + 4, 1);

    return Buffer.concat([header, body]);
  }

  function cstring(value: string): Buffer {
    return Buffer.from(`${value}\0`, 'utf8');
  }

  function errorResponse(code: string, text: string): Buffer {
    return message(
      'E',
      Buffer.concat([
        Buffer.from('S'),
        cstring('FATAL'),
        Buffer.from('V'),
        cstring('FATAL'),
        Buffer.from('C'),
        cstring(code),
        Buffer.from('M'),
        cstring(text),
        Buffer.from([0]),
      ]),
    );
  }

  const AUTH_OK_AND_READY = Buffer.concat([
    message('R', Buffer.from([0, 0, 0, 0])),
    message('Z', Buffer.from('I')),
  ]);

  /** Respuesta de `select 1 as ok`: una columna int4 con el valor 1. */
  function selectOneResponse(): Buffer {
    const field = Buffer.alloc(18);

    // tabla 0 (4), columna 0 (2), tipo int4 = 23 (4), tamaño 4 (2), modificador -1 (4), formato texto 0 (2)
    field.writeInt32BE(0, 0);
    field.writeInt16BE(0, 4);
    field.writeInt32BE(23, 6);
    field.writeInt16BE(4, 10);
    field.writeInt32BE(-1, 12);
    field.writeInt16BE(0, 16);

    const count = Buffer.alloc(2);

    count.writeInt16BE(1);

    const value = Buffer.from('1');
    const length = Buffer.alloc(4);

    length.writeInt32BE(value.length);

    return Buffer.concat([
      message('T', Buffer.concat([count, cstring('ok'), field])),
      message('D', Buffer.concat([count, length, value])),
      message('C', cstring('SELECT 1')),
      message('Z', Buffer.from('I')),
    ]);
  }

  const servers: net.Server[] = [];

  async function startServer(mode: Mode) {
    const server = net.createServer((socket) => {
      let started = false;

      socket.on('error', () => {});
      socket.on('data', () => {
        if (!started) {
          started = true;

          if (mode === 'drop-on-startup') {
            socket.destroy();
          } else if (mode === 'shutdown') {
            socket.end(
              errorResponse('57P01', 'terminating connection due to administrator command'),
            );
          } else if (mode === 'reject-auth') {
            socket.end(errorResponse('28P01', 'password authentication failed'));
          } else {
            socket.write(AUTH_OK_AND_READY);
          }

          return;
        }

        if (mode === 'drop-on-query') {
          socket.destroy();
        } else {
          socket.write(selectOneResponse());
        }
      });
    });

    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return (server.address() as net.AddressInfo).port;
  }

  /** Un puerto en el que no escucha nadie: el sistema rechaza la conexión. */
  async function closedPort() {
    const server = net.createServer();

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as net.AddressInfo;

    await new Promise<void>((resolve) => server.close(() => resolve()));

    return port;
  }

  /** Hace que `createPgClient` arme un `pg.Client` REAL contra el servidor local y sin TLS. */
  function useLocalServer(port: number) {
    const RealClient = pg.Client;
    const spy = vi.spyOn(pg, 'Client').mockImplementation(function (config: pg.ClientConfig) {
      return new RealClient({ ...config, host: '127.0.0.1', port, ssl: false });
    } as never);

    return () => spy.mockRestore();
  }

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('con una base que responde, la lectura devuelve 1 (el driver entrega el int4 como número)', async () => {
    const restore = useLocalServer(await startServer('ok'));

    try {
      await expect(probeDatabaseAvailability({ env: VALID_ENV })).resolves.toBe(1);
    } finally {
      restore();
    }
  });

  it('si la base corta la conexión ya autenticada, es 0 y el proceso no se cae', async () => {
    const restore = useLocalServer(await startServer('drop-on-query'));

    try {
      await expect(probeDatabaseAvailability({ env: VALID_ENV })).resolves.toBe(0);
    } finally {
      restore();
    }
  });

  it('con un puerto equivocado (nadie escucha) se omite como connection-failed: no es una caída', async () => {
    const restore = useLocalServer(await closedPort());

    try {
      const error = await failureOf(probeDatabaseAvailability({ env: VALID_ENV }));

      expect(error.reason).toBe('connection-failed');
    } finally {
      restore();
    }
  });

  it('si algo corta la conexión antes de autenticar (sin respuesta de Postgres), se omite', async () => {
    const restore = useLocalServer(await startServer('drop-on-startup'));

    try {
      const error = await failureOf(probeDatabaseAvailability({ env: VALID_ENV }));

      expect(error.reason).toBe('connection-failed');
    } finally {
      restore();
    }
  });

  it('si la base informa que se está apagando (57P01), es 0', async () => {
    const restore = useLocalServer(await startServer('shutdown'));

    try {
      await expect(probeDatabaseAvailability({ env: VALID_ENV })).resolves.toBe(0);
    } finally {
      restore();
    }
  });

  it('si la base rechaza las credenciales (28P01), se omite como permission-denied y no es 0', async () => {
    const restore = useLocalServer(await startServer('reject-auth'));

    try {
      const error = await failureOf(probeDatabaseAvailability({ env: VALID_ENV }));

      expect(error.reason).toBe('permission-denied');
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain(PASSWORD);
    } finally {
      restore();
    }
  });
});
