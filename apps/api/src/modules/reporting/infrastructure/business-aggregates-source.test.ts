import { describe, it, expect, vi } from 'vitest';
import {
  BUSINESS_AGGREGATES,
  PERSONAL_DATA_TABLES,
  checkDirectReadsDenied,
  readBusinessAggregates,
  type BusinessAggregates,
} from './business-aggregates-source.js';
import type { CatalogSqlClient, CatalogSqlClientFactory } from './catalog-match-count-source.js';

const PASSWORD = 'p@ss/w0rd:secreta';
const VALID_URL = `postgresql://watchparty_reporter.abcdefgh:${encodeURIComponent(PASSWORD)}@db.example.test:6543/postgres?sslmode=verify-full`;

const NOW = new Date('2026-10-22T12:00:00Z');
const CUTOFF = new Date('2026-10-22T03:00:00Z');

const VALID_ENV = { REPORTER_DATABASE_URL: VALID_URL };

type Row = { value: unknown; omission_reason: unknown };

/** Respuesta (o error) de cada agregado, por nombre de función. */
type Responses = Partial<Record<string, Row[] | { error: unknown }>>;

interface FakeClientOptions {
  connectError?: unknown;
  endError?: unknown;
  responses?: Responses;
}

const OK_RESPONSES: Responses = {
  rated_match_rate: [{ value: 40, omission_reason: null }],
  monthly_interactions_avg: [{ value: 4 / 3, omission_reason: null }],
};

function fakeClient(options: FakeClientOptions = {}) {
  const responses = options.responses ?? OK_RESPONSES;

  const client = {
    connect: vi.fn(async () => {
      if (options.connectError !== undefined) throw options.connectError;
    }),
    query: vi.fn<CatalogSqlClient['query']>(async (sql) => {
      const name = /reporting\.(\w+)\(/.exec(sql)?.[1] ?? '';
      const response = responses[name];

      if (response === undefined) throw new Error(`consulta inesperada: ${sql}`);
      if ('error' in response) throw response.error;
      return { rows: response };
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

function read(
  options: FakeClientOptions = {},
  env: NodeJS.ProcessEnv = VALID_ENV,
  cutoff: Date = CUTOFF,
) {
  const client = fakeClient(options);
  const createClient = vi.fn<CatalogSqlClientFactory>(() => client);
  const result = readBusinessAggregates(cutoff, { env, createClient, now: () => NOW });

  return { client, createClient, result };
}

function bothFailed(reason: string): BusinessAggregates {
  return {
    rated_match_rate: { ok: false, reason },
    monthly_interactions_avg: { ok: false, reason },
  } as BusinessAggregates;
}

describe('readBusinessAggregates: consulta', () => {
  it('lee ambos agregados autorizados con el mismo corte T y no lee tablas', async () => {
    const { client, result } = read();

    await expect(result).resolves.toEqual({
      rated_match_rate: { ok: true, value: 40, unit: '%' },
      monthly_interactions_avg: { ok: true, value: 4 / 3, unit: '{interaction}/{user}' },
    });

    expect(client.query).toHaveBeenCalledTimes(2);

    const calls = client.query.mock.calls;

    expect(calls[0]![0]).toContain('reporting.rated_match_rate($1::timestamptz)');
    expect(calls[1]![0]).toContain('reporting.monthly_interactions_avg($1::timestamptz)');

    for (const [sql, values] of calls) {
      expect(sql).not.toMatch(/\bfrom\s+(public\.|reporting\.\w+\s|\w+\s*$)/i);
      expect(values).toEqual([CUTOFF.toISOString()]);
    }
  });

  it('usa una sola conexión para los dos agregados y la cierra', async () => {
    const { client, createClient, result } = read();

    await result;

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('las unidades son % e {interaction}/{user}', () => {
    expect(BUSINESS_AGGREGATES.map(({ kpi, unit }) => [kpi, unit])).toEqual([
      ['rated_match_rate', '%'],
      ['monthly_interactions_avg', '{interaction}/{user}'],
    ]);
  });

  it('acepta los límites del dominio: 0 y 100 %, promedio 0 y decimales', async () => {
    const { result } = read({
      responses: {
        rated_match_rate: [{ value: 100, omission_reason: null }],
        monthly_interactions_avg: [{ value: 0, omission_reason: null }],
      },
    });

    await expect(result).resolves.toEqual({
      rated_match_rate: { ok: true, value: 100, unit: '%' },
      monthly_interactions_avg: { ok: true, value: 0, unit: '{interaction}/{user}' },
    });

    const zero = read({
      responses: { ...OK_RESPONSES, rated_match_rate: [{ value: 0, omission_reason: null }] },
    });

    await expect(zero.result).resolves.toMatchObject({
      rated_match_rate: { ok: true, value: 0 },
    });
  });

  it('cerrar la conexión con error no tapa los resultados', async () => {
    const { result } = read({ endError: new Error('cierre') });

    await expect(result).resolves.toMatchObject({ rated_match_rate: { ok: true, value: 40 } });
  });
});

describe('readBusinessAggregates: motivos del agregado', () => {
  it('sin denominador propaga "no-denominator", nunca un cero', async () => {
    const { result } = read({
      responses: {
        rated_match_rate: [{ value: null, omission_reason: 'no-denominator' }],
        monthly_interactions_avg: [{ value: 4, omission_reason: null }],
      },
    });

    await expect(result).resolves.toEqual({
      rated_match_rate: { ok: false, reason: 'no-denominator' },
      monthly_interactions_avg: { ok: true, value: 4, unit: '{interaction}/{user}' },
    });
  });

  it('propaga "invalid-cutoff" si el agregado rechaza el corte', async () => {
    const { result } = read({
      responses: {
        ...OK_RESPONSES,
        monthly_interactions_avg: [{ value: null, omission_reason: 'invalid-cutoff' }],
      },
    });

    await expect(result).resolves.toMatchObject({
      monthly_interactions_avg: { ok: false, reason: 'invalid-cutoff' },
    });
  });

  it.each<[string, Row[]]>([
    ['sin filas', []],
    [
      'varias filas',
      [
        { value: 1, omission_reason: null },
        { value: 2, omission_reason: null },
      ],
    ],
    ['valor nulo sin motivo', [{ value: null, omission_reason: null }]],
    ['valor como texto', [{ value: '40', omission_reason: null }]],
    ['NaN', [{ value: Number.NaN, omission_reason: null }]],
    ['infinito', [{ value: Number.POSITIVE_INFINITY, omission_reason: null }]],
    ['negativo', [{ value: -1, omission_reason: null }]],
    ['porcentaje mayor a 100', [{ value: 100.5, omission_reason: null }]],
    ['motivo desconocido', [{ value: null, omission_reason: 'otro' }]],
    ['valor y motivo a la vez', [{ value: 0, omission_reason: 'no-denominator' }]],
  ])('%s en rated_match_rate es "invalid-result" y no afecta al otro KPI', async (_, rows) => {
    const { result } = read({ responses: { ...OK_RESPONSES, rated_match_rate: rows } });

    await expect(result).resolves.toEqual({
      rated_match_rate: { ok: false, reason: 'invalid-result' },
      monthly_interactions_avg: { ok: true, value: 4 / 3, unit: '{interaction}/{user}' },
    });
  });

  it('un promedio negativo o no finito es "invalid-result"', async () => {
    for (const value of [-0.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const { result } = read({
        responses: {
          ...OK_RESPONSES,
          monthly_interactions_avg: [{ value, omission_reason: null }],
        },
      });

      await expect(result).resolves.toMatchObject({
        monthly_interactions_avg: { ok: false, reason: 'invalid-result' },
      });
    }
  });

  it('una fila sin la columna omission_reason es "invalid-result"', async () => {
    const { result } = read({
      responses: { ...OK_RESPONSES, rated_match_rate: [{ value: 40 } as Row] },
    });

    await expect(result).resolves.toMatchObject({
      rated_match_rate: { ok: false, reason: 'invalid-result' },
    });
  });
});

describe('readBusinessAggregates: configuración y corte', () => {
  it('sin REPORTER_DATABASE_URL omite ambos con "config-missing" sin conectar', async () => {
    const { createClient, result } = read({}, {});

    await expect(result).resolves.toEqual(bothFailed('config-missing'));
    expect(createClient).not.toHaveBeenCalled();
  });

  it('una URL sin sslmode=verify-full omite ambos con "config-invalid"', async () => {
    const { createClient, result } = read(
      {},
      { REPORTER_DATABASE_URL: VALID_URL.replace('verify-full', 'require') },
    );

    await expect(result).resolves.toEqual(bothFailed('config-invalid'));
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(['postgres', 'service_role', 'supabase_admin'])(
    'rechaza el usuario privilegiado %s: no reutiliza credenciales privilegiadas',
    async (role) => {
      const { createClient, result } = read(
        {},
        { REPORTER_DATABASE_URL: VALID_URL.replace('watchparty_reporter', role) },
      );

      await expect(result).resolves.toEqual(bothFailed('config-invalid'));
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it('no cae a SUPABASE_SERVICE_ROLE_KEY ni a DATABASE_URL', async () => {
    const { createClient, result } = read(
      {},
      { SUPABASE_SERVICE_ROLE_KEY: 'clave', DATABASE_URL: VALID_URL },
    );

    await expect(result).resolves.toEqual(bothFailed('config-missing'));
    expect(createClient).not.toHaveBeenCalled();
  });

  it('un corte futuro o inválido omite ambos con "invalid-cutoff" sin conectar', async () => {
    for (const cutoff of [new Date(NOW.getTime() + 1), new Date('no es una fecha')]) {
      const { createClient, result } = read({}, VALID_ENV, cutoff);

      await expect(result).resolves.toEqual(bothFailed('invalid-cutoff'));
      expect(createClient).not.toHaveBeenCalled();
    }
  });
});

describe('readBusinessAggregates: permisos y fuente', () => {
  it.each([
    ['contraseña rechazada (28P01)', sqlError('28P01'), 'permission-denied'],
    ['rol sin LOGIN (28000)', sqlError('28000'), 'permission-denied'],
    ['red o TLS', new Error('self-signed certificate'), 'connection-failed'],
  ])('al conectar, %s omite ambos con "%s"', async (_, error, reason) => {
    const { client, result } = read({ connectError: error });

    await expect(result).resolves.toEqual(bothFailed(reason));
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('sin EXECUTE sobre un agregado (42501) omite solo ese KPI con "permission-denied"', async () => {
    const { result } = read({
      responses: { ...OK_RESPONSES, monthly_interactions_avg: { error: sqlError('42501') } },
    });

    await expect(result).resolves.toEqual({
      rated_match_rate: { ok: true, value: 40, unit: '%' },
      monthly_interactions_avg: { ok: false, reason: 'permission-denied' },
    });
  });

  it('una función inexistente u otro fallo de consulta es "query-failed"', async () => {
    const { result } = read({
      responses: { ...OK_RESPONSES, rated_match_rate: { error: sqlError('42883') } },
    });

    await expect(result).resolves.toMatchObject({
      rated_match_rate: { ok: false, reason: 'query-failed' },
      monthly_interactions_avg: { ok: true },
    });
  });

  it('los desenlaces no incluyen texto del driver, la URL ni la contraseña', async () => {
    const leaky = sqlError(
      '28P01',
      `password authentication failed for user "watchparty_reporter" (${PASSWORD}) en ${VALID_URL}`,
    );
    const { result } = read({ connectError: leaky });

    const serialized = JSON.stringify(await result);

    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('db.example.test');
    expect(serialized).not.toContain('watchparty_reporter');
    expect(serialized).not.toContain('authentication');
  });
});

describe('checkDirectReadsDenied', () => {
  function probe(queryError: (sql: string) => unknown, env: NodeJS.ProcessEnv = VALID_ENV) {
    const client = {
      connect: vi.fn(async () => {}),
      query: vi.fn<CatalogSqlClient['query']>(async (sql) => {
        const error = queryError(sql);
        if (error !== undefined) throw error;
        return { rows: [{ '?column?': 1 }] };
      }),
      end: vi.fn(async () => {}),
    };
    const createClient = vi.fn<CatalogSqlClientFactory>(() => client);

    return { client, createClient, result: checkDirectReadsDenied({ env, createClient }) };
  }

  it('marca "denied" cada tabla personal que Postgres rechaza con 42501', async () => {
    const { client, result } = probe(() => sqlError('42501'));

    await expect(result).resolves.toEqual(
      Object.fromEntries(PERSONAL_DATA_TABLES.map((table) => [table, 'denied'])),
    );

    for (const [sql] of client.query.mock.calls) {
      expect(sql).toMatch(/^select 1 from \S+ limit 1$/);
    }
  });

  it('marca "readable" si el rol puede leer una tabla personal', async () => {
    const { result } = probe((sql) =>
      sql.includes('public.watched_matches') ? undefined : sqlError('42501'),
    );

    await expect(result).resolves.toMatchObject({
      'public.watched_matches': 'readable',
      'public.match_ratings': 'denied',
    });
  });

  it('otro error no se toma como denegación', async () => {
    const { result } = probe(() => sqlError('57014'));

    await expect(result).resolves.toMatchObject({ 'public.room_comments': 'query-failed' });
  });

  it('un login rechazado es "login-rejected", no una denegación de lectura', async () => {
    const client = {
      connect: vi.fn(async () => {
        throw sqlError('28P01');
      }),
      query: vi.fn<CatalogSqlClient['query']>(async () => ({ rows: [] })),
      end: vi.fn(async () => {}),
    };
    const result = checkDirectReadsDenied({ env: VALID_ENV, createClient: () => client });

    await expect(result).resolves.toMatchObject({ 'public.watched_matches': 'login-rejected' });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('sin configuración no conecta', async () => {
    const { createClient, result } = probe(() => undefined, {});

    await expect(result).resolves.toMatchObject({ 'public.watched_matches': 'config-missing' });
    expect(createClient).not.toHaveBeenCalled();
  });
});
