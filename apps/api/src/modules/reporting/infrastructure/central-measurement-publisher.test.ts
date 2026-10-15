import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMeasurementBatch, serializeBatchPayload } from '../domain/measurement-batch.js';
import {
  MAX_PUBLISH_ATTEMPTS,
  publishMeasurements,
  readCentralPublisherConfig,
} from './central-measurement-publisher.js';

// Todo lo de este archivo es SIMULADO: el servidor es local, las claves son
// inventadas y los datos no provienen de ninguna fuente real. Nada de esto es
// evidencia de recepción en la plataforma central.
const SIMULATED_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SIMULATED_PUBLISHABLE_KEY = 'sb_publishable_SIMULATED_PUBLISHABLE_KEY';
const SIMULATED_PROJECT_KEY = 'SIMULATED_PROJECT_KEY_abc123';
const SIMULATED_SERVICE_ROLE_KEY = 'sb_secret_SIMULATED_SERVICE_ROLE_KEY';

const SIMULATED_RESULTS = [
  { kpi: 'catalog_match_count', value: 4210 },
  { kpi: 'health_response_latency', value: 312.456 },
  { kpi: 'health_up', value: 1 },
  { kpi: 'auth_guard_up', value: 1 },
  { kpi: 'report_collection_duration', value: 1.591 },
];

function simulatedRows(overrides: { runId?: string; results?: typeof SIMULATED_RESULTS } = {}) {
  const built = buildMeasurementBatch({
    env: 'dev',
    cutoff: new Date('2026-10-14T15:00:00Z'),
    runId: overrides.runId ?? SIMULATED_RUN_ID,
    results: overrides.results ?? SIMULATED_RESULTS,
    omissions: [],
    simulated: true,
  });

  if (!built.ok) throw new Error('El lote simulado debería ser válido.');

  return built.batch.rows;
}

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** `number` responde ese estado; `drop` corta la conexión; `hang` nunca responde. */
type Step = number | 'drop' | 'hang' | { status: number; location: string };

const servers: { close: () => Promise<void> }[] = [];

async function startServer(handler: (recorded: Recorded, index: number) => Step) {
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
      const step = handler(recorded, requests.length);

      requests.push(recorded);

      if (step === 'drop') return req.socket.destroy();
      if (step === 'hang') return;

      const status = typeof step === 'number' ? step : step.status;
      const headers = typeof step === 'number' ? {} : { Location: step.location };

      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end('{"message":"cuerpo del servidor que no se archiva"}');
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

/** Responde en orden los estados de `script`; si se agota, falla con 599 (no debería pasar). */
function scripted(script: Step[]) {
  return (_recorded: Recorded, index: number): Step => script[index] ?? 599;
}

function envFor(url: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    REPORTER_CENTRAL_URL: url,
    REPORTER_CENTRAL_PUBLISHABLE_KEY: SIMULATED_PUBLISHABLE_KEY,
    REPORTER_CENTRAL_PROJECT_KEY: SIMULATED_PROJECT_KEY,
    ...overrides,
  };
}

function fakeSleep() {
  return vi.fn<(ms: number) => Promise<void>>(async () => {});
}

function jwtWithRole(role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role })}.firma-simulada`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe('publishMeasurements: URL, headers y cuerpo del contrato', () => {
  it('hace POST a /rest/v1/measurement con on_conflict, apikey, X-Project-Key y Prefer', async () => {
    const server = await startServer(scripted([201]));

    await publishMeasurements(simulatedRows(), { env: envFor(server.url), sleep: fakeSleep() });

    expect(server.requests).toHaveLength(1);

    const request = server.requests[0]!;

    expect(request.method).toBe('POST');
    expect(request.url).toBe('/rest/v1/measurement?on_conflict=project_id,kpi_id,date,env');
    expect(request.headers.apikey).toBe(SIMULATED_PUBLISHABLE_KEY);
    expect(request.headers['x-project-key']).toBe(SIMULATED_PROJECT_KEY);
    expect(request.headers.prefer).toBe('resolution=ignore-duplicates');
    expect(request.headers['content-type']).toBe('application/json');
    // Solo la clave publicable y la privada del proyecto; ninguna otra credencial.
    expect(request.headers.authorization).toBeUndefined();
  });

  it('el cuerpo es el lote validado: filas con exactamente los cinco campos', async () => {
    const server = await startServer(scripted([201]));
    const rows = simulatedRows();

    await publishMeasurements(rows, { env: envFor(server.url), sleep: fakeSleep() });

    const sent = JSON.parse(server.requests[0]!.body) as Record<string, unknown>[];
    const expected = serializeBatchPayload(rows);

    expect(expected.ok && server.requests[0]!.body).toBe(expected.ok && expected.json);
    expect(sent).toHaveLength(5);

    for (const row of sent) {
      expect(Object.keys(row)).toEqual(['kpi_id', 'date', 'env', 'value', 'run_id']);
    }

    for (const forbidden of ['project_id', 'reported_at', 'team_id', 'status', 'measured_at']) {
      expect(server.requests[0]!.body).not.toContain(forbidden);
    }
  });

  it('una base con barra final no genera una URL con doble barra', async () => {
    const server = await startServer(scripted([201]));

    await publishMeasurements(simulatedRows(), {
      env: envFor(`${server.url}/`),
      sleep: fakeSleep(),
    });

    expect(server.requests[0]!.url).toBe(
      '/rest/v1/measurement?on_conflict=project_id,kpi_id,date,env',
    );
  });

  it('un envío aceptado devuelve el resultado sanitizado y no se da por verificado', async () => {
    const server = await startServer(scripted([201]));

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
    });

    expect(result).toEqual({
      ok: true,
      run_id: SIMULATED_RUN_ID,
      env: 'dev',
      rows: 5,
      attempts: [{ attempt: 1, outcome: 'accepted', status: 201 }],
      verified: false,
    });
  });
});

describe('publishMeasurements: reintentos del mismo JSON', () => {
  it('ante un 5xx reintenta con el mismo cuerpo y el mismo run_id', async () => {
    const server = await startServer(scripted([503, 201]));
    const sleep = fakeSleep();

    const result = await publishMeasurements(simulatedRows(), { env: envFor(server.url), sleep });

    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['server-error', 'accepted']);
    expect(server.requests).toHaveLength(2);
    // Byte a byte el mismo JSON, y por lo tanto el mismo run_id.
    expect(server.requests[1]!.body).toBe(server.requests[0]!.body);

    const runIds = server.requests.flatMap((r) =>
      (JSON.parse(r.body) as { run_id: string }[]).map((row) => row.run_id),
    );

    expect(new Set(runIds)).toEqual(new Set([SIMULATED_RUN_ID]));
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it('ante falta de respuesta (conexión cortada) reintenta hasta tener éxito en el tercer intento', async () => {
    const server = await startServer(scripted(['drop', 'drop', 201]));
    const sleep = fakeSleep();

    const result = await publishMeasurements(simulatedRows(), { env: envFor(server.url), sleep });

    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      'network-error',
      'network-error',
      'accepted',
    ]);
    expect(server.requests).toHaveLength(3);
    expect(new Set(server.requests.map((r) => r.body)).size).toBe(1);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it('un timeout cuenta como falta de respuesta y se reintenta', async () => {
    const server = await startServer(scripted(['hang', 201]));

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
      timeoutMs: 50,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['timeout', 'accepted']);
  });

  it('hace como máximo tres intentos totales ante 5xx y falla', async () => {
    const server = await startServer(scripted([500, 502, 503, 201]));

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
    });

    expect(MAX_PUBLISH_ATTEMPTS).toBe(3);
    expect(server.requests).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('server-error');
    expect(result.attempts).toEqual([
      { attempt: 1, outcome: 'server-error', status: 500 },
      { attempt: 2, outcome: 'server-error', status: 502 },
      { attempt: 3, outcome: 'server-error', status: 503 },
    ]);
  });

  it('hace como máximo tres intentos totales ante falta de respuesta y falla', async () => {
    const server = await startServer(scripted(['drop', 'drop', 'drop', 201]));

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
    });

    expect(server.requests).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network-error');
  });

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'un %i no se reintenta: falla en el primer intento y sin espera',
    async (status) => {
      const server = await startServer(scripted([status, 201]));
      const sleep = fakeSleep();

      const result = await publishMeasurements(simulatedRows(), { env: envFor(server.url), sleep });

      expect(server.requests).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('client-error');
      expect(result.attempts).toEqual([{ attempt: 1, outcome: 'client-error', status }]);
    },
  );

  it('si tras un 5xx llega un 4xx, deja de reintentar', async () => {
    const server = await startServer(scripted([500, 400, 201]));

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
    });

    expect(server.requests).toHaveLength(2);
    expect(result.reason).toBe('client-error');
  });

  it('una redirección no se sigue (no reenvía las claves) ni se reintenta', async () => {
    const elsewhere = await startServer(scripted([201]));
    const server = await startServer(
      scripted([{ status: 302, location: `${elsewhere.url}/robado` }]),
    );

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
    });

    expect(server.requests).toHaveLength(1);
    expect(elsewhere.requests).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unexpected-status');
  });
});

describe('publishMeasurements: inmutabilidad', () => {
  // Servidor que imita a PostgREST: con `resolution=ignore-duplicates` ignora la
  // fila repetida; con `merge-duplicates` la actualizaría.
  function startPostgrestLikeServer() {
    const stored = new Map<string, number>();
    const methods: (string | undefined)[] = [];

    const server = startServer((request) => {
      methods.push(request.method);

      const merge = request.headers.prefer?.includes('merge-duplicates');

      for (const row of JSON.parse(request.body) as {
        kpi_id: string;
        date: string;
        env: string;
        value: number;
      }[]) {
        const key = `${row.kpi_id}|${row.date}|${row.env}`;

        if (!stored.has(key) || merge) stored.set(key, row.value);
      }

      return 201;
    });

    return { server, stored, methods };
  }

  it('el primer valor aceptado se conserva: reenviar no duplica ni corrige', async () => {
    const { server: pending, stored, methods } = startPostgrestLikeServer();
    const server = await pending;
    const env = envFor(server.url);

    const first = simulatedRows();
    const corrected = simulatedRows({
      runId: '22222222-2222-4222-8222-222222222222',
      results: SIMULATED_RESULTS.map((r) =>
        r.kpi === 'catalog_match_count' ? { ...r, value: 9999 } : r,
      ),
    });

    await publishMeasurements(first, { env, sleep: fakeSleep() });
    await publishMeasurements(corrected, { env, sleep: fakeSleep() });

    expect(stored.get('catalog_match_count|2026-10-14|dev')).toBe(4210);
    expect(stored.size).toBe(5);
    // Nunca hay un PATCH, PUT ni DELETE: solo POST con ignore-duplicates.
    expect(new Set(methods)).toEqual(new Set(['POST']));
    expect(server.requests.every((r) => r.headers.prefer === 'resolution=ignore-duplicates')).toBe(
      true,
    );
  });
});

describe('publishMeasurements: configuración y claves', () => {
  function neverCalled() {
    return vi.fn<typeof fetch>(async () => {
      throw new Error('No debería haber ninguna petición.');
    });
  }

  it.each([
    ['sin URL', { REPORTER_CENTRAL_URL: undefined }],
    ['sin clave publicable', { REPORTER_CENTRAL_PUBLISHABLE_KEY: undefined }],
    ['sin clave del proyecto', { REPORTER_CENTRAL_PROJECT_KEY: undefined }],
    ['URL vacía', { REPORTER_CENTRAL_URL: '  ' }],
    ['clave del proyecto vacía', { REPORTER_CENTRAL_PROJECT_KEY: '' }],
  ])('%s: no hay envío (config-missing)', async (_label, overrides) => {
    const fetchFn = neverCalled();

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor('https://central.example.test', overrides),
      fetchFn,
      sleep: fakeSleep(),
    });

    expect(result.reason).toBe('config-missing');
    expect(result.attempts).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('no usa otras credenciales del entorno como reemplazo', async () => {
    const fetchFn = neverCalled();

    const result = await publishMeasurements(simulatedRows(), {
      env: {
        SUPABASE_URL: 'https://propio.example.test',
        SUPABASE_SERVICE_ROLE_KEY: SIMULATED_SERVICE_ROLE_KEY,
        SUPABASE_ANON_KEY: 'anon',
      },
      fetchFn,
      sleep: fakeSleep(),
    });

    expect(result.reason).toBe('config-missing');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['texto que no es URL', { REPORTER_CENTRAL_URL: 'no es una url' }],
    ['http fuera de loopback', { REPORTER_CENTRAL_URL: 'http://central.example.test' }],
    ['protocolo no http', { REPORTER_CENTRAL_URL: 'ftp://central.example.test' }],
    ['URL con credenciales', { REPORTER_CENTRAL_URL: 'https://u:p@central.example.test' }],
    ['URL con ruta', { REPORTER_CENTRAL_URL: 'https://central.example.test/rest/v1' }],
    ['URL con query', { REPORTER_CENTRAL_URL: 'https://central.example.test/?a=1' }],
    [
      'clave publicable de rol de servicio (formato nuevo)',
      { REPORTER_CENTRAL_PUBLISHABLE_KEY: SIMULATED_SERVICE_ROLE_KEY },
    ],
    [
      'clave publicable que es un JWT service_role',
      { REPORTER_CENTRAL_PUBLISHABLE_KEY: jwtWithRole('service_role') },
    ],
    [
      'clave del proyecto de rol de servicio',
      { REPORTER_CENTRAL_PROJECT_KEY: jwtWithRole('service_role') },
    ],
  ])('%s: no hay envío (config-invalid)', async (_label, overrides) => {
    const fetchFn = neverCalled();

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor('https://central.example.test', overrides),
      fetchFn,
      sleep: fakeSleep(),
    });

    expect(result.reason).toBe('config-invalid');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('acepta una clave publicable legada (JWT con rol anon) y https', () => {
    const result = readCentralPublisherConfig(
      envFor('https://central.example.test', {
        REPORTER_CENTRAL_PUBLISHABLE_KEY: jwtWithRole('anon'),
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('nunca envía una clave de servicio del entorno: ni en headers, ni en URL, ni en cuerpo', async () => {
    const server = await startServer(scripted([201]));

    await publishMeasurements(simulatedRows(), {
      env: envFor(server.url, { SUPABASE_SERVICE_ROLE_KEY: SIMULATED_SERVICE_ROLE_KEY }),
      sleep: fakeSleep(),
    });

    const request = server.requests[0]!;
    const everything = JSON.stringify([request.url, request.headers, request.body]);

    expect(everything).not.toContain(SIMULATED_SERVICE_ROLE_KEY);
  });

  it('las claves viajan solo en headers: no aparecen en la URL ni en el cuerpo', async () => {
    const server = await startServer(scripted([201]));

    await publishMeasurements(simulatedRows(), { env: envFor(server.url), sleep: fakeSleep() });

    const request = server.requests[0]!;

    for (const secret of [SIMULATED_PUBLISHABLE_KEY, SIMULATED_PROJECT_KEY]) {
      expect(request.url).not.toContain(secret);
      expect(request.body).not.toContain(secret);
    }
  });
});

describe('publishMeasurements: lote inválido', () => {
  const invalidBatches: [string, unknown][] = [
    ['no es un array', {}],
    ['vacío', []],
    ['con un valor NaN', [{ ...simulatedRows()[2]!, value: Number.NaN }]],
    ['con un campo prohibido', [{ ...simulatedRows()[2]!, project_id: 'x' }]],
    ['con posiciones vacías', new Array(1)],
    ['con un KPI fuera del catálogo', [{ ...simulatedRows()[2]!, kpi_id: 'rated_match_rate' }]],
  ];

  it.each(invalidBatches)('%s: no se envía nada (invalid-batch)', async (_label, rows) => {
    const fetchFn = vi.fn<typeof fetch>();

    const result = await publishMeasurements(rows, {
      env: envFor('https://central.example.test'),
      fetchFn,
      sleep: fakeSleep(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-batch');
    expect(result.attempts).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('publishMeasurements: resultado archivable y sin secretos', () => {
  it('ni el resultado ni la consola exponen claves, URL ni cuerpos de respuesta', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const failing = await startServer(scripted([500, 500, 500]));
    const rejected = await startServer(scripted([403]));

    const results = [
      await publishMeasurements(simulatedRows(), { env: envFor(failing.url), sleep: fakeSleep() }),
      await publishMeasurements(simulatedRows(), { env: envFor(rejected.url), sleep: fakeSleep() }),
      // Un fallo cuyo mensaje trae las claves: no debe llegar al resultado.
      await publishMeasurements(simulatedRows(), {
        env: envFor('https://central.example.test'),
        fetchFn: async () => {
          throw new Error(
            `boom apikey=${SIMULATED_PUBLISHABLE_KEY} x-project-key=${SIMULATED_PROJECT_KEY}`,
          );
        },
        sleep: fakeSleep(),
      }),
    ];

    const archived = JSON.stringify(results);

    for (const secret of [
      SIMULATED_PUBLISHABLE_KEY,
      SIMULATED_PROJECT_KEY,
      failing.url,
      'central.example.test',
      'cuerpo del servidor',
    ]) {
      expect(archived).not.toContain(secret);
    }

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('el resultado se serializa y se recupera igual, solo con campos fijos', async () => {
    const server = await startServer(scripted([503, 201]));

    const result = await publishMeasurements(simulatedRows(), {
      env: envFor(server.url),
      sleep: fakeSleep(),
    });

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(Object.keys(result)).toEqual(['ok', 'run_id', 'env', 'rows', 'attempts', 'verified']);
    expect(result.verified).toBe(false);
  });

  it('un fallo de configuración también deja un resultado archivable', async () => {
    const result = await publishMeasurements(simulatedRows(), { env: {}, sleep: fakeSleep() });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: false,
      reason: 'config-missing',
      run_id: null,
      env: null,
      rows: 0,
      attempts: [],
      verified: false,
    });
  });
});
