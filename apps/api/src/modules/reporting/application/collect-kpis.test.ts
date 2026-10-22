import { describe, it, expect, vi } from 'vitest';
import {
  collectKpis,
  readReporterApiBaseUrl,
  type ApiBaseUrlConfig,
  type CollectKpisDeps,
} from './collect-kpis.js';
import {
  BUSINESS_AGGREGATES,
  type BusinessAggregateFailureReason,
  type BusinessAggregateOutcome,
  type BusinessAggregates,
} from '../infrastructure/business-aggregates-source.js';
import {
  CatalogMatchCountSourceError,
  type CatalogQueryRead,
} from '../infrastructure/catalog-match-count-source.js';
import { KPI_CATALOG } from '../domain/kpi-catalog.js';
import type { ProbeAuthFailureReason, ProbeTokenRun } from '../infrastructure/probe-auth.js';
import { OMISSION_REASONS, buildMeasurementBatch } from '../domain/measurement-batch.js';

const BASE = 'https://api.example.test';
const NOW = new Date('2026-10-14T15:00:00Z');

interface Scenario {
  apiBaseUrl?: ApiBaseUrlConfig;
  healthStatus?: number;
  healthError?: Error;
  healthMs?: number;
  guardStatus?: number;
  guardError?: Error;
  guardMs?: number;
  catalog?: () => Promise<CatalogQueryRead>;
  /** Agregados de negocio: un desenlace por KPI (valor u omisión con motivo). */
  business?: () => Promise<BusinessAggregates>;
  businessMs?: number;
  /** Lectura mínima de la base (`database_up`): 1, 0 o un fallo con motivo. */
  database?: () => Promise<0 | 1>;
  catalogMs?: number;
  /** GET /matches autenticado (cuenta técnica de lectura). */
  readStatus?: number;
  readError?: Error;
  readBody?: string;
  readMs?: number;
  /** Si no hay token: el motivo con el que `withProbeToken` lo informa. */
  tokenFailure?: ProbeAuthFailureReason;
  tokenThrows?: Error;
  now?: Date;
}

/** Una lectura del catálogo: el conteo y cuánto tardó la consulta que lo trajo. */
function catalogRead(value: number, queryDurationMs = 35.1234): CatalogQueryRead {
  return { count: { value, unit: '{match}' }, queryDurationMs };
}

/** Los dos KPIs de negocio con valores válidos, salvo lo que se pida distinto. */
function businessOutcomes(overrides: Partial<BusinessAggregates> = {}): BusinessAggregates {
  return {
    rated_match_rate: { ok: true, value: 62.5, unit: '%' },
    monthly_interactions_avg: { ok: true, value: 3.4, unit: '{interaction}/{user}' },
    ...overrides,
  };
}

/** Ambos KPIs de negocio omitidos con el mismo motivo (fallo de configuración, conexión, etc.). */
function allBusinessFailed(reason: BusinessAggregateFailureReason): BusinessAggregates {
  const failed: BusinessAggregateOutcome = { ok: false, reason };

  return { rated_match_rate: failed, monthly_interactions_avg: failed };
}

function setup(scenario: Scenario = {}) {
  let clockMs = 5_000;

  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    // `GET /matches` con token es el sondeo de lectura autenticada; sin token, el del guard.
    if (String(url).endsWith('/matches') && new Headers(init?.headers).has('Authorization')) {
      clockMs += scenario.readMs ?? 0;

      if (scenario.readError) throw scenario.readError;

      return {
        status: scenario.readStatus ?? 200,
        text: async () => scenario.readBody ?? JSON.stringify({ matches: [] }),
      } as unknown as Response;
    }

    const isHealth = String(url).endsWith('/health');
    const error = isHealth ? scenario.healthError : scenario.guardError;

    clockMs += isHealth ? (scenario.healthMs ?? 120) : (scenario.guardMs ?? 80);

    if (error) throw error;

    const status = isHealth ? (scenario.healthStatus ?? 200) : (scenario.guardStatus ?? 401);

    return { status, text: async () => '' } as unknown as Response;
  });

  const readCatalog = vi.fn<CollectKpisDeps['readCatalog']>(async () => {
    clockMs += scenario.catalogMs ?? 50;
    return scenario.catalog ? scenario.catalog() : catalogRead(12);
  });

  const readBusinessAggregates = vi.fn<CollectKpisDeps['readBusinessAggregates']>(async () => {
    clockMs += scenario.businessMs ?? 0;

    return scenario.business ? scenario.business() : businessOutcomes();
  });

  const probeDatabase = vi.fn<CollectKpisDeps['probeDatabase']>(async () =>
    scenario.database ? scenario.database() : 1,
  );

  const withProbeToken = vi.fn(
    async <T>(use: (accessToken: string) => Promise<T>): Promise<ProbeTokenRun<T>> => {
      if (scenario.tokenThrows) throw scenario.tokenThrows;
      if (scenario.tokenFailure) return { ok: false, reason: scenario.tokenFailure };

      return { ok: true, value: await use('token-simulado') };
    },
  );

  const nowFn = vi.fn(() => scenario.now ?? NOW);

  const deps: CollectKpisDeps = {
    apiBaseUrl: scenario.apiBaseUrl ?? { ok: true, baseUrl: BASE },
    readCatalog,
    readBusinessAggregates,
    probeDatabase,
    // `vi.fn` pierde el genérico de la función: se vuelve a tipar para la dependencia.
    withProbeToken: withProbeToken as CollectKpisDeps['withProbeToken'],
    fetchFn,
    now: nowFn,
    monotonicMs: () => clockMs,
  };

  return {
    deps,
    fetchFn,
    readCatalog,
    readBusinessAggregates,
    probeDatabase,
    withProbeToken,
    nowFn,
  };
}

function valueOf(artifact: Awaited<ReturnType<typeof collectKpis>>, kpi: string) {
  return artifact.results.find((result) => result.kpi === kpi)?.value;
}

function reasonOf(artifact: Awaited<ReturnType<typeof collectKpis>>, kpi: string) {
  return artifact.omissions.find((omission) => omission.kpi === kpi)?.reason;
}

function timeoutError() {
  return Object.assign(new Error('timeout'), { name: 'TimeoutError' });
}

describe('collectKpis: todas las fuentes válidas', () => {
  it('devuelve todos los KPIs del catálogo con tipo, unidad y valores reales y finitos', async () => {
    const { deps } = setup();

    const artifact = await collectKpis(deps);

    expect(artifact.omissions).toEqual([]);
    expect(artifact.results).toEqual([
      { kpi: 'rated_match_rate', kind: 'business', unit: '%', value: 62.5 },
      {
        kpi: 'monthly_interactions_avg',
        kind: 'business',
        unit: '{interaction}/{user}',
        value: 3.4,
      },
      { kpi: 'catalog_match_count', kind: 'technical', unit: '{match}', value: 12 },
      { kpi: 'health_response_latency', kind: 'technical', unit: 'ms', value: 120 },
      { kpi: 'catalog_query_latency', kind: 'technical', unit: 'ms', value: 35.123 },
      { kpi: 'health_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'database_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'catalog_read_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'auth_guard_up', kind: 'health', unit: '1', value: 1 },
      // 120 ms + 80 ms de sondeos + 50 ms de consulta SQL = 0,25 s.
      { kpi: 'report_collection_duration', kind: 'technical', unit: 's', value: 0.25 },
    ]);
    expect(artifact.results.every((result) => Number.isFinite(result.value))).toBe(true);
  });

  it('sondea /health y /matches y consulta el catálogo al corte T', async () => {
    const { deps, fetchFn, readCatalog } = setup();

    const artifact = await collectKpis(deps);

    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/health`,
      `${BASE}/matches`,
      `${BASE}/matches`,
    ]);
    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(readCatalog.mock.calls[0]![0].toISOString()).toBe(artifact.cutoff);
  });

  it('no incluye datos personales ni la URL sondeada', async () => {
    const { deps } = setup();

    const text = JSON.stringify(await collectKpis(deps));

    expect(text).not.toContain('example.test');
    expect(Object.keys(JSON.parse(text))).toEqual(['cutoff', 'localDate', 'results', 'omissions']);
  });
});

describe('collectKpis: corte T y fecha local', () => {
  it('fija el corte una sola vez por corrida', async () => {
    const { deps, nowFn } = setup();

    const artifact = await collectKpis(deps);

    expect(nowFn).toHaveBeenCalledTimes(1);
    expect(artifact.cutoff).toBe('2026-10-14T15:00:00.000Z');
  });

  it.each([
    ['2026-10-14T15:00:00Z', '2026-10-14'],
    ['2026-10-14T02:30:00Z', '2026-10-13'], // 23:30 del día anterior en Argentina (UTC-3)
    ['2026-10-14T03:00:00Z', '2026-10-14'], // 00:00 en Argentina
    ['2026-12-31T23:59:00Z', '2026-12-31'],
    ['2027-01-01T02:59:00Z', '2026-12-31'],
  ])('el corte %s cae en la fecha local %s', async (cutoff, localDate) => {
    const { deps } = setup({ now: new Date(cutoff) });

    expect((await collectKpis(deps)).localDate).toBe(localDate);
  });
});

describe('collectKpis: health_up y health_response_latency', () => {
  it('un 200 da health_up=1 y la latencia monotónica', async () => {
    const { deps } = setup({ healthStatus: 200, healthMs: 340 });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(1);
    expect(valueOf(artifact, 'health_response_latency')).toBe(340);
  });

  it('un 5xx comprobado da health_up=0 y omite la latencia', async () => {
    const { deps } = setup({ healthStatus: 503 });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(0);
    expect(reasonOf(artifact, 'health_response_latency')).toBe('not-200');
  });

  it.each([404, 429, 302])(
    'un %i no se informa como caída del servicio: se omite con motivo',
    async (healthStatus) => {
      const { deps } = setup({ healthStatus });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'health_up')).toBeUndefined();
      expect(reasonOf(artifact, 'health_up')).toBe('unexpected-status');
      expect(reasonOf(artifact, 'health_response_latency')).toBe('not-200');
    },
  );

  it.each([
    ['timeout', timeoutError()],
    ['network-error', new TypeError('fetch failed')],
  ])(
    'sin respuesta (%s) se omiten health_up y la latencia, no se informa 0',
    async (reason, healthError) => {
      const { deps } = setup({ healthError });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'health_up')).toBeUndefined();
      expect(reasonOf(artifact, 'health_up')).toBe(reason);
      expect(reasonOf(artifact, 'health_response_latency')).toBe(reason);
    },
  );
});

describe('collectKpis: auth_guard_up', () => {
  it('un 401 sin token da auth_guard_up=1', async () => {
    const { deps } = setup({ guardStatus: 401 });

    expect(valueOf(await collectKpis(deps), 'auth_guard_up')).toBe(1);
  });

  it.each([200, 403, 404, 500])(
    'otro estado recibido (%i) da auth_guard_up=0',
    async (guardStatus) => {
      const { deps } = setup({ guardStatus });

      expect(valueOf(await collectKpis(deps), 'auth_guard_up')).toBe(0);
    },
  );

  it.each([
    ['timeout', timeoutError()],
    ['network-error', new TypeError('fetch failed')],
  ])('sin respuesta (%s) se omite con motivo', async (reason, guardError) => {
    const { deps } = setup({ guardError });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'auth_guard_up')).toBeUndefined();
    expect(reasonOf(artifact, 'auth_guard_up')).toBe(reason);
  });

  it('un sondeo caído no arrastra a los demás KPIs', async () => {
    const { deps } = setup({ guardError: new TypeError('fetch failed') });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(1);
    expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
  });
});

describe('collectKpis: catalog_match_count', () => {
  it('cero es un valor válido cuando la fuente respondió cero', async () => {
    const { deps } = setup({ catalog: async () => catalogRead(0) });

    expect(valueOf(await collectKpis(deps), 'catalog_match_count')).toBe(0);
  });

  it.each([
    'config-missing',
    'config-invalid',
    'connection-failed',
    'permission-denied',
    'query-failed',
    'invalid-result',
  ] as const)(
    'un fallo de la fuente SQL (%s) se omite con ese motivo, no se vuelve cero',
    async (reason) => {
      const { deps } = setup({
        catalog: async () => {
          throw new CatalogMatchCountSourceError(reason);
        },
      });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'catalog_match_count')).toBeUndefined();
      expect(reasonOf(artifact, 'catalog_match_count')).toBe(reason);
      // Las demás fuentes siguen su curso.
      expect(valueOf(artifact, 'health_up')).toBe(1);
      expect(valueOf(artifact, 'report_collection_duration')).toBeDefined();
    },
  );

  it('un error inesperado se omite sin filtrar su mensaje', async () => {
    const { deps } = setup({
      catalog: async () => {
        throw new Error('password=secreta host=db.interno');
      },
    });

    const artifact = await collectKpis(deps);

    expect(reasonOf(artifact, 'catalog_match_count')).toBe('unexpected-error');
    expect(JSON.stringify(artifact)).not.toContain('secreta');
  });

  it.each([
    ['NaN', Number.NaN],
    ['negativo', -1],
    ['decimal', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('un valor inválido (%s) se omite como invalid-value', async (_label, value) => {
    const { deps } = setup({ catalog: async () => catalogRead(value) });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'catalog_match_count')).toBeUndefined();
    expect(reasonOf(artifact, 'catalog_match_count')).toBe('invalid-value');
  });
});

describe('collectKpis: configuración de la API ausente o inválida', () => {
  it.each(['api-config-missing', 'api-config-invalid'] as const)(
    '%s omite los cuatro KPIs HTTP sin hacer ninguna petición',
    async (reason) => {
      const { deps, fetchFn } = setup({ apiBaseUrl: { ok: false, reason } });

      const artifact = await collectKpis(deps);

      expect(fetchFn).not.toHaveBeenCalled();
      expect(artifact.omissions).toEqual([
        { kpi: 'health_response_latency', reason },
        { kpi: 'health_up', reason },
        { kpi: 'catalog_read_up', reason },
        { kpi: 'auth_guard_up', reason },
      ]);
      expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
      expect(valueOf(artifact, 'report_collection_duration')).toBeDefined();
    },
  );
});

describe('collectKpis: report_collection_duration', () => {
  it('usa solo el reloj monotónico: el reloj de pared no la afecta', async () => {
    // `now` devuelve siempre el mismo instante y la duración sigue saliendo del monotónico.
    const { deps } = setup({ healthMs: 1_000, guardMs: 500, catalogMs: 250 });

    expect(valueOf(await collectKpis(deps), 'report_collection_duration')).toBe(1.75);
  });

  it('está presente aunque todas las demás fuentes se omitan', async () => {
    const { deps } = setup({
      healthError: new TypeError('fetch failed'),
      guardError: new TypeError('fetch failed'),
      readError: new TypeError('fetch failed'),
      business: async () => allBusinessFailed('connection-failed'),
      database: async () => {
        throw new CatalogMatchCountSourceError('connection-failed');
      },
      catalog: async () => {
        throw new CatalogMatchCountSourceError('connection-failed');
      },
    });

    const artifact = await collectKpis(deps);

    expect(artifact.results.map((result) => result.kpi)).toEqual(['report_collection_duration']);
    expect(artifact.omissions).toHaveLength(9);
  });

  it('un reloj monotónico que retrocede produce una duración inválida y se omite', async () => {
    const { deps } = setup();
    let calls = 0;

    const artifact = await collectKpis({
      ...deps,
      monotonicMs: () => 10_000 - (calls += 1) * 1_000,
    });

    expect(valueOf(artifact, 'report_collection_duration')).toBeUndefined();
    expect(reasonOf(artifact, 'report_collection_duration')).toBe('invalid-value');
  });
});

describe('readReporterApiBaseUrl', () => {
  it('lee la base de REPORTER_API_BASE_URL sin barras finales', () => {
    expect(readReporterApiBaseUrl({ REPORTER_API_BASE_URL: ` ${BASE}/// ` })).toEqual({
      ok: true,
      baseUrl: BASE,
    });
  });

  it.each([{}, { REPORTER_API_BASE_URL: '' }, { REPORTER_API_BASE_URL: '   ' }])(
    'sin valor (%j) es api-config-missing',
    (env) => {
      expect(readReporterApiBaseUrl(env)).toEqual({ ok: false, reason: 'api-config-missing' });
    },
  );

  it.each([
    'no es una url',
    'ftp://api.example.test',
    'https://api.example.test/?x=1',
    'https://api.example.test/#frag',
  ])('rechaza %s como api-config-invalid', (REPORTER_API_BASE_URL) => {
    expect(readReporterApiBaseUrl({ REPORTER_API_BASE_URL })).toEqual({
      ok: false,
      reason: 'api-config-invalid',
    });
  });

  // El sondeo de lectura autenticada manda el token de la cuenta técnica en un
  // header: por HTTP sin cifrar lo expondría. Solo se admite HTTP en loopback.
  it.each([
    'http://api.example.test',
    'http://api.example.test:3000',
    'http://192.168.1.10:3000',
    'http://10.0.0.5',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
  ])('exige HTTPS: rechaza %s (HTTP fuera de loopback)', (REPORTER_API_BASE_URL) => {
    expect(readReporterApiBaseUrl({ REPORTER_API_BASE_URL })).toEqual({
      ok: false,
      reason: 'api-config-invalid',
    });
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'permite HTTP solo en loopback, para desarrollo local: %s',
    (REPORTER_API_BASE_URL) => {
      expect(readReporterApiBaseUrl({ REPORTER_API_BASE_URL })).toEqual({
        ok: true,
        baseUrl: REPORTER_API_BASE_URL,
      });
    },
  );

  it('con una base HTTP no cifrada el token ni siquiera se pide y no sale ningún pedido', async () => {
    const { deps, fetchFn, withProbeToken } = setup({
      apiBaseUrl: readReporterApiBaseUrl({ REPORTER_API_BASE_URL: 'http://api.example.test' }),
    });

    const artifact = await collectKpis(deps);

    expect(withProbeToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(artifact.omissions).toContainEqual({
      kpi: 'catalog_read_up',
      reason: 'api-config-invalid',
    });
  });
});

// Contrato con el catálogo y el lote (WAT-200): el colector no tiene copias propias.
describe('collectKpis: catálogo y lote del reporter', () => {
  const SIMULATED_RUN_ID = '11111111-1111-4111-8111-111111111111';

  it('los KPIs, tipos y unidades del artefacto son los del catálogo, en su orden', async () => {
    const { deps } = setup();

    const artifact = await collectKpis(deps);

    expect(artifact.results.map(({ kpi, kind, unit }) => ({ id: kpi, kind, unit }))).toEqual(
      KPI_CATALOG.map(({ id, kind, unit }) => ({ id, kind, unit })),
    );
  });

  it('la fecha local es la del lote: mismo cálculo para el corte T', async () => {
    const { deps } = setup({ now: new Date('2026-10-14T02:59:59.999Z') });

    const artifact = await collectKpis(deps);
    const batch = buildMeasurementBatch({
      env: 'dev',
      cutoff: new Date(artifact.cutoff),
      runId: SIMULATED_RUN_ID,
      results: artifact.results,
      omissions: artifact.omissions,
      simulated: true,
    });

    expect(artifact.localDate).toBe('2026-10-13');
    expect(batch.ok && batch.batch.date).toBe(artifact.localDate);
  });

  it('con todas las fuentes válidas, el artefacto arma un lote completo', async () => {
    const { deps } = setup();

    const artifact = await collectKpis(deps);
    const batch = buildMeasurementBatch({
      env: 'dev',
      cutoff: new Date(artifact.cutoff),
      runId: SIMULATED_RUN_ID,
      results: artifact.results,
      omissions: artifact.omissions,
      simulated: true,
    });

    expect(batch.ok).toBe(true);
    expect(batch.ok && batch.batch.rows).toHaveLength(10);
    expect(batch.ok && batch.batch.complete).toBe(true);
  });

  it('con una fuente omitida, el lote sale incompleto y con fallo visible', async () => {
    const { deps } = setup({ guardError: new TypeError('fetch failed') });

    const artifact = await collectKpis(deps);
    const batch = buildMeasurementBatch({
      env: 'dev',
      cutoff: new Date(artifact.cutoff),
      runId: SIMULATED_RUN_ID,
      results: artifact.results,
      omissions: artifact.omissions,
      simulated: true,
    });

    expect(batch.ok && batch.batch.rows).toHaveLength(9);
    expect(batch.ok && batch.batch.complete).toBe(false);
    expect(batch.ok && batch.batch.visible_failure).toBe(true);
    expect(batch.ok && batch.batch.omissions).toEqual([
      { kpi_id: 'auth_guard_up', reason: 'network-error' },
    ]);
  });

  it('todos los motivos de omisión que produce el colector son códigos conocidos del lote', async () => {
    const scenarios: Scenario[] = [
      { apiBaseUrl: { ok: false, reason: 'api-config-missing' } },
      { apiBaseUrl: { ok: false, reason: 'api-config-invalid' } },
      { healthError: timeoutError(), guardError: new TypeError('fetch failed') },
      { healthStatus: 503 },
      { healthStatus: 404 },
      { catalog: async () => catalogRead(-1) },
      {
        catalog: async () => {
          throw new Error('inesperado');
        },
      },
      ...(
        [
          'config-missing',
          'config-invalid',
          'connection-failed',
          'permission-denied',
          'query-failed',
          'invalid-result',
        ] as const
      ).map((reason) => ({
        catalog: async (): Promise<CatalogQueryRead> => {
          throw new CatalogMatchCountSourceError(reason);
        },
      })),
    ];
    const reasons = new Set<string>();

    for (const scenario of scenarios) {
      const artifact = await collectKpis(setup(scenario).deps);

      for (const omission of artifact.omissions) reasons.add(omission.reason);
    }

    expect(reasons.size).toBeGreaterThan(8);

    for (const reason of reasons) {
      expect(OMISSION_REASONS as readonly string[]).toContain(reason);
    }
  });
});

// `catalog_read_up`: GET /matches con el token de la cuenta técnica de lectura.
describe('collectKpis: catalog_read_up', () => {
  const MATCH = {
    id: 'm1',
    homeTeam: 'Everton FC',
    homeTeamId: 't1',
    awayTeam: 'Chelsea FC',
    awayTeamId: 't2',
    kickoffAt: '2026-10-17T11:30:00Z',
    status: 'scheduled',
    score: null,
  };
  const valid = JSON.stringify({ matches: [MATCH] });

  it('una respuesta 200 con el esquema esperado es 1', async () => {
    const { deps } = setup({ readBody: valid });

    expect(valueOf(await collectKpis(deps), 'catalog_read_up')).toBe(1);
  });

  it('un catálogo vacío sigue siendo 1: la lectura funciona aunque no haya partidos', async () => {
    const { deps } = setup({ readBody: JSON.stringify({ matches: [] }) });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'catalog_read_up')).toBe(1);
    expect(reasonOf(artifact, 'catalog_read_up')).toBeUndefined();
  });

  it('pide GET /matches CON el token y sin otras credenciales', async () => {
    const { deps, fetchFn, withProbeToken } = setup();

    await collectKpis(deps);

    const authenticated = fetchFn.mock.calls.filter(([, init]) =>
      new Headers(init?.headers).has('Authorization'),
    );

    expect(withProbeToken).toHaveBeenCalledTimes(1);
    expect(authenticated).toHaveLength(1);
    expect(String(authenticated[0]![0])).toBe(`${BASE}/matches`);
    expect(new Headers(authenticated[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer token-simulado',
    );
  });

  it.each([
    ['sin el envoltorio matches', JSON.stringify([MATCH])],
    ['matches que no es una lista', JSON.stringify({ matches: 'x' })],
    ['un partido sin campos', JSON.stringify({ matches: [{ id: 'm1' }] })],
    ['un estado desconocido', JSON.stringify({ matches: [{ ...MATCH, status: 'otro' }] })],
    [
      'un marcador inválido',
      JSON.stringify({ matches: [{ ...MATCH, score: { home: -1, away: 0 } }] }),
    ],
    ['un cuerpo que no es JSON', '<html>Bad Gateway</html>'],
    ['un cuerpo vacío', ''],
  ])(
    'un 200 con una respuesta malformada (%s) es un fallo del servicio: 0',
    async (_label, readBody) => {
      const { deps } = setup({ readBody });

      expect(valueOf(await collectKpis(deps), 'catalog_read_up')).toBe(0);
    },
  );

  it('acepta el marcador de un partido finalizado', async () => {
    const finished = { ...MATCH, status: 'finished', score: { home: 2, away: 1 } };
    const { deps } = setup({ readBody: JSON.stringify({ matches: [finished] }) });

    expect(valueOf(await collectKpis(deps), 'catalog_read_up')).toBe(1);
  });

  it.each([500, 502, 503])('un %i es un fallo comprobado del servicio: 0', async (readStatus) => {
    const { deps } = setup({ readStatus });

    expect(valueOf(await collectKpis(deps), 'catalog_read_up')).toBe(0);
  });

  it.each([401, 403])(
    'un %i con un token recién emitido no prueba una caída: se omite como unauthorized',
    async (readStatus) => {
      const { deps } = setup({ readStatus });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'catalog_read_up')).toBeUndefined();
      expect(reasonOf(artifact, 'catalog_read_up')).toBe('unauthorized');
    },
  );

  it.each([404, 429, 302])(
    'un %i se omite como unexpected-status, no como caída',
    async (readStatus) => {
      const { deps } = setup({ readStatus });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'catalog_read_up')).toBeUndefined();
      expect(reasonOf(artifact, 'catalog_read_up')).toBe('unexpected-status');
    },
  );

  it.each([
    ['timeout', timeoutError()],
    ['network-error', new TypeError('fetch failed')],
  ])('sin respuesta (%s) se omite con motivo, no es 0', async (reason, readError) => {
    const { deps } = setup({ readError });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'catalog_read_up')).toBeUndefined();
    expect(reasonOf(artifact, 'catalog_read_up')).toBe(reason);
  });

  it.each(['config-missing', 'config-invalid', 'credentials-invalid', 'auth-unavailable'] as const)(
    'si no hay token (%s) se omite con ese motivo y no se hace ningún pedido autenticado',
    async (reason) => {
      const { deps, fetchFn } = setup({ tokenFailure: reason });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'catalog_read_up')).toBeUndefined();
      expect(reasonOf(artifact, 'catalog_read_up')).toBe(reason);
      expect(
        fetchFn.mock.calls.filter(([, init]) => new Headers(init?.headers).has('Authorization')),
      ).toHaveLength(0);
    },
  );

  it('un error inesperado al obtener el token se omite sin filtrar su mensaje', async () => {
    const { deps } = setup({ tokenThrows: new Error('password=secreta host=auth.interno') });

    const artifact = await collectKpis(deps);

    expect(reasonOf(artifact, 'catalog_read_up')).toBe('unexpected-error');
    expect(JSON.stringify(artifact)).not.toContain('secreta');
  });

  it('el token nunca aparece en el artefacto', async () => {
    const { deps } = setup({ readBody: valid });

    expect(JSON.stringify(await collectKpis(deps))).not.toContain('token-simulado');
  });

  it('un fallo del sondeo autenticado no arrastra a los demás KPIs', async () => {
    const { deps } = setup({ readError: new TypeError('fetch failed') });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(1);
    expect(valueOf(artifact, 'auth_guard_up')).toBe(1);
    expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
  });

  it('sin la base de la API no hay sondeo autenticado ni se pide el token', async () => {
    const { deps, withProbeToken } = setup({
      apiBaseUrl: { ok: false, reason: 'api-config-missing' },
    });

    const artifact = await collectKpis(deps);

    expect(withProbeToken).not.toHaveBeenCalled();
    expect(reasonOf(artifact, 'catalog_read_up')).toBe('api-config-missing');
  });
});

// `catalog_query_latency`: la duración de la consulta SQL del catálogo, que llega de la
// misma lectura que el conteo (una sola consulta).
describe('collectKpis: catalog_query_latency', () => {
  it('toma la duración de la consulta del catálogo, redondeada a milisegundos con tres decimales', async () => {
    const { deps } = setup({ catalog: async () => catalogRead(12, 41.123456) });

    const artifact = await collectKpis(deps);

    expect(artifact.results).toContainEqual({
      kpi: 'catalog_query_latency',
      kind: 'technical',
      unit: 'ms',
      value: 41.123,
    });
  });

  it('no es la duración total del reporter: son dos KPIs con valores y unidades distintos', async () => {
    // La consulta tarda 7,5 ms; el reporte entero tarda 250 ms (120 + 80 + 50).
    const { deps } = setup({ catalog: async () => catalogRead(12, 7.5) });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'catalog_query_latency')).toBe(7.5);
    expect(valueOf(artifact, 'report_collection_duration')).toBe(0.25);
  });

  it('una consulta instantánea informa 0, que es una latencia válida', async () => {
    const { deps } = setup({ catalog: async () => catalogRead(12, 0) });

    expect(valueOf(await collectKpis(deps), 'catalog_query_latency')).toBe(0);
  });

  it('pide el catálogo una sola vez y con el corte T: una consulta alimenta los dos KPIs', async () => {
    const { deps, readCatalog } = setup();

    const artifact = await collectKpis(deps);

    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(readCatalog.mock.calls[0]![0].toISOString()).toBe(artifact.cutoff);
    expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
    expect(valueOf(artifact, 'catalog_query_latency')).toBeDefined();
  });

  it.each([
    'config-missing',
    'config-invalid',
    'connection-failed',
    'permission-denied',
    'query-failed',
    'invalid-result',
  ] as const)(
    'si la fuente falla (%s) se omite la latencia con el mismo motivo que el conteo, sin valor',
    async (reason) => {
      const { deps } = setup({
        catalog: async () => {
          throw new CatalogMatchCountSourceError(reason);
        },
      });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'catalog_query_latency')).toBeUndefined();
      expect(reasonOf(artifact, 'catalog_query_latency')).toBe(reason);
      expect(reasonOf(artifact, 'catalog_match_count')).toBe(reason);
    },
  );

  it('un error inesperado omite la latencia sin filtrar su mensaje', async () => {
    const { deps } = setup({
      catalog: async () => {
        throw new Error('password=secreta host=db.interno');
      },
    });

    const artifact = await collectKpis(deps);

    expect(reasonOf(artifact, 'catalog_query_latency')).toBe('unexpected-error');
    expect(JSON.stringify(artifact)).not.toContain('secreta');
  });

  it.each([
    ['NaN', Number.NaN],
    ['negativa', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'una duración inválida (%s) se omite como invalid-value y no afecta al conteo',
    async (_label, durationMs) => {
      const { deps } = setup({ catalog: async () => catalogRead(12, durationMs) });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'catalog_query_latency')).toBeUndefined();
      expect(reasonOf(artifact, 'catalog_query_latency')).toBe('invalid-value');
      expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
    },
  );

  it('un conteo inválido no invalida la latencia de una consulta que sí terminó', async () => {
    const { deps } = setup({ catalog: async () => catalogRead(-1, 20) });

    const artifact = await collectKpis(deps);

    expect(reasonOf(artifact, 'catalog_match_count')).toBe('invalid-value');
    expect(valueOf(artifact, 'catalog_query_latency')).toBe(20);
  });

  it('un fallo del catálogo no arrastra a los sondeos HTTP', async () => {
    const { deps } = setup({
      catalog: async () => {
        throw new CatalogMatchCountSourceError('permission-denied');
      },
    });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(1);
    expect(valueOf(artifact, 'health_response_latency')).toBe(120);
    expect(valueOf(artifact, 'auth_guard_up')).toBe(1);
  });
});

// `database_up`: lectura SQL mínima de la base, independiente de /health y del catálogo.
describe('collectKpis: database_up', () => {
  it('un 1 de la lectura mínima se informa como 1', async () => {
    const { deps } = setup({ database: async () => 1 });

    expect(valueOf(await collectKpis(deps), 'database_up')).toBe(1);
  });

  it('una indisponibilidad comprobada se informa como 0, que es un valor, no una omisión', async () => {
    const { deps } = setup({ database: async () => 0 });

    const artifact = await collectKpis(deps);

    expect(artifact.results).toContainEqual({
      kpi: 'database_up',
      kind: 'health',
      unit: '1',
      value: 0,
    });
    expect(reasonOf(artifact, 'database_up')).toBeUndefined();
  });

  it('hace la lectura una sola vez por corrida', async () => {
    const { deps, probeDatabase } = setup();

    await collectKpis(deps);

    expect(probeDatabase).toHaveBeenCalledTimes(1);
  });

  it.each([
    'config-missing',
    'config-invalid',
    'connection-failed',
    'permission-denied',
    'query-failed',
    'invalid-result',
  ] as const)(
    'si el motivo no es una caída (%s) se omite con ese motivo y no se informa 0',
    async (reason) => {
      const { deps } = setup({
        database: async () => {
          throw new CatalogMatchCountSourceError(reason);
        },
      });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'database_up')).toBeUndefined();
      expect(reasonOf(artifact, 'database_up')).toBe(reason);
    },
  );

  it('un error inesperado se omite sin filtrar su mensaje', async () => {
    const { deps } = setup({
      database: async () => {
        throw new Error('password=secreta host=db.interno');
      },
    });

    const artifact = await collectKpis(deps);

    expect(reasonOf(artifact, 'database_up')).toBe('unexpected-error');
    expect(JSON.stringify(artifact)).not.toContain('secreta');
  });

  it('/health no sustituye a la lectura: con /health caído la base puede seguir en 1', async () => {
    const { deps } = setup({ healthStatus: 503, database: async () => 1 });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(0);
    expect(valueOf(artifact, 'database_up')).toBe(1);
  });

  it('ni al revés: con /health sano la base puede estar en 0', async () => {
    const { deps } = setup({ healthStatus: 200, database: async () => 0 });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBe(1);
    expect(valueOf(artifact, 'database_up')).toBe(0);
  });

  it('un /health sin respuesta no cambia database_up', async () => {
    const { deps } = setup({ healthError: new TypeError('fetch failed'), database: async () => 1 });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'health_up')).toBeUndefined();
    expect(valueOf(artifact, 'database_up')).toBe(1);
  });

  it('no depende de la consulta del catálogo: con el catálogo fallando sigue en 1', async () => {
    const { deps } = setup({
      database: async () => 1,
      catalog: async () => {
        throw new CatalogMatchCountSourceError('query-failed');
      },
    });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'database_up')).toBe(1);
    expect(reasonOf(artifact, 'catalog_match_count')).toBe('query-failed');
  });

  it('y su fallo no arrastra al conteo del catálogo ni a los sondeos HTTP', async () => {
    const { deps } = setup({
      database: async () => {
        throw new CatalogMatchCountSourceError('permission-denied');
      },
    });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
    expect(valueOf(artifact, 'health_up')).toBe(1);
    expect(valueOf(artifact, 'auth_guard_up')).toBe(1);
  });

  it('no depende de la configuración de la API: se lee igual sin REPORTER_API_BASE_URL', async () => {
    const { deps, probeDatabase } = setup({
      apiBaseUrl: { ok: false, reason: 'api-config-missing' },
      database: async () => 1,
    });

    const artifact = await collectKpis(deps);

    expect(probeDatabase).toHaveBeenCalledTimes(1);
    expect(valueOf(artifact, 'database_up')).toBe(1);
  });
});

// Integración de las cinco fuentes nuevas con las cinco existentes: los diez KPIs de ADR-05.
describe('collectKpis: diez KPIs con los de negocio', () => {
  const BUSINESS_IDS = BUSINESS_AGGREGATES.map(({ kpi }) => kpi);

  it('con las diez fuentes válidas devuelve diez resultados finitos y ninguna omisión', async () => {
    const { deps } = setup();

    const artifact = await collectKpis(deps);

    expect(artifact.results).toHaveLength(10);
    expect(artifact.omissions).toEqual([]);
    expect(artifact.results.every((result) => Number.isFinite(result.value))).toBe(true);
    expect(artifact.results.map((r) => r.kpi)).toEqual(KPI_CATALOG.map((kpi) => kpi.id));
  });

  it('los resultados de negocio llevan su tipo, su unidad y su valor tal cual los calculó la base', async () => {
    const { deps } = setup({
      business: async () =>
        businessOutcomes({
          rated_match_rate: { ok: true, value: 62.5, unit: '%' },
          monthly_interactions_avg: { ok: true, value: 2.75, unit: '{interaction}/{user}' },
        }),
    });

    const artifact = await collectKpis(deps);

    expect(artifact.results).toContainEqual({
      kpi: 'rated_match_rate',
      kind: 'business',
      unit: '%',
      value: 62.5,
    });
    expect(artifact.results).toContainEqual({
      kpi: 'monthly_interactions_avg',
      kind: 'business',
      unit: '{interaction}/{user}',
      value: 2.75,
    });
  });

  it('los KPIs de negocio se piden una sola vez y con el MISMO corte T que el resto', async () => {
    const { deps, readBusinessAggregates, readCatalog, nowFn } = setup();

    const artifact = await collectKpis(deps);

    expect(nowFn).toHaveBeenCalledTimes(1);
    expect(readBusinessAggregates).toHaveBeenCalledTimes(1);
    expect(readBusinessAggregates.mock.calls[0]![0].toISOString()).toBe(artifact.cutoff);
    expect(readBusinessAggregates.mock.calls[0]![0].getTime()).toBe(
      readCatalog.mock.calls[0]![0].getTime(),
    );
  });

  it('el corte común fija también la fecha argentina de los diez', async () => {
    const { deps } = setup({ now: new Date('2026-10-14T02:30:00Z') });

    const artifact = await collectKpis(deps);
    const batch = buildMeasurementBatch({
      env: 'dev',
      cutoff: new Date(artifact.cutoff),
      runId: '11111111-1111-4111-8111-111111111111',
      results: artifact.results,
      omissions: artifact.omissions,
      simulated: true,
    });

    expect(artifact.localDate).toBe('2026-10-13');
    expect(batch.ok && new Set(batch.batch.rows.map((r) => r.date))).toEqual(
      new Set(['2026-10-13']),
    );
    expect(batch.ok && batch.batch.rows).toHaveLength(10);
  });

  it.each([0, 37.5, 100])('el porcentaje acepta %d', async (value) => {
    const { deps } = setup({
      business: async () => businessOutcomes({ rated_match_rate: { ok: true, value, unit: '%' } }),
    });

    expect(valueOf(await collectKpis(deps), 'rated_match_rate')).toBe(value);
  });

  it.each([100.01, 250, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'un porcentaje fuera de 0–100 (%s) se omite como invalid-value, aunque la fuente lo entregue',
    async (value) => {
      const { deps } = setup({
        business: async () =>
          businessOutcomes({ rated_match_rate: { ok: true, value, unit: '%' } }),
      });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'rated_match_rate')).toBeUndefined();
      expect(reasonOf(artifact, 'rated_match_rate')).toBe('invalid-value');
    },
  );

  it.each([0, 0.4, 3.14159, 87])('el promedio acepta el decimal no negativo %s', async (value) => {
    const { deps } = setup({
      business: async () =>
        businessOutcomes({
          monthly_interactions_avg: { ok: true, value, unit: '{interaction}/{user}' },
        }),
    });

    expect(valueOf(await collectKpis(deps), 'monthly_interactions_avg')).toBe(value);
  });

  it.each([-0.1, Number.NaN, Number.NEGATIVE_INFINITY])(
    'un promedio inválido (%s) se omite como invalid-value',
    async (value) => {
      const { deps } = setup({
        business: async () =>
          businessOutcomes({
            monthly_interactions_avg: { ok: true, value, unit: '{interaction}/{user}' },
          }),
      });

      const artifact = await collectKpis(deps);

      expect(valueOf(artifact, 'monthly_interactions_avg')).toBeUndefined();
      expect(reasonOf(artifact, 'monthly_interactions_avg')).toBe('invalid-value');
    },
  );

  it('sin denominador cada KPI de negocio se omite con su motivo y no se rellena con 0', async () => {
    const { deps } = setup({
      business: async () =>
        businessOutcomes({
          rated_match_rate: { ok: false, reason: 'no-denominator' },
          monthly_interactions_avg: { ok: false, reason: 'no-denominator' },
        }),
    });

    const artifact = await collectKpis(deps);

    for (const kpi of BUSINESS_IDS) {
      expect(valueOf(artifact, kpi)).toBeUndefined();
      expect(reasonOf(artifact, kpi)).toBe('no-denominator');
    }

    expect(artifact.results).toHaveLength(8);
    expect(artifact.results.some((r) => BUSINESS_IDS.includes(r.kpi as never))).toBe(false);
  });

  it('un KPI de negocio sin base no arrastra al otro: cada uno se decide por separado', async () => {
    const { deps } = setup({
      business: async () =>
        businessOutcomes({
          rated_match_rate: { ok: false, reason: 'no-denominator' },
          monthly_interactions_avg: { ok: true, value: 4.5, unit: '{interaction}/{user}' },
        }),
    });

    const artifact = await collectKpis(deps);

    expect(reasonOf(artifact, 'rated_match_rate')).toBe('no-denominator');
    expect(valueOf(artifact, 'monthly_interactions_avg')).toBe(4.5);
  });

  it.each([
    'config-missing',
    'config-invalid',
    'invalid-cutoff',
    'connection-failed',
    'permission-denied',
    'query-failed',
    'invalid-result',
  ] as const)(
    'si la fuente de negocio falla (%s) ambos KPIs se omiten con ese motivo y el resto sigue',
    async (reason) => {
      const { deps } = setup({ business: async () => allBusinessFailed(reason) });

      const artifact = await collectKpis(deps);

      for (const kpi of BUSINESS_IDS) {
        expect(valueOf(artifact, kpi)).toBeUndefined();
        expect(reasonOf(artifact, kpi)).toBe(reason);
      }

      expect(artifact.results).toHaveLength(8);
      expect(valueOf(artifact, 'catalog_match_count')).toBe(12);
      expect(valueOf(artifact, 'health_up')).toBe(1);
    },
  );

  it('un error inesperado de la fuente omite los dos sin filtrar su mensaje', async () => {
    const { deps } = setup({
      business: async () => {
        throw new Error('password=secreta host=db.interno');
      },
    });

    const artifact = await collectKpis(deps);

    for (const kpi of BUSINESS_IDS) {
      expect(reasonOf(artifact, kpi)).toBe('unexpected-error');
    }

    expect(JSON.stringify(artifact)).not.toContain('secreta');
  });

  it('los KPIs de negocio no dependen de la API ni de los sondeos HTTP', async () => {
    const { deps } = setup({
      apiBaseUrl: { ok: false, reason: 'api-config-missing' },
      healthError: new TypeError('fetch failed'),
    });

    const artifact = await collectKpis(deps);

    expect(valueOf(artifact, 'rated_match_rate')).toBe(62.5);
    expect(valueOf(artifact, 'monthly_interactions_avg')).toBe(3.4);
  });

  it('con todas las fuentes fallando solo queda la duración y se conservan los motivos de las demás', async () => {
    const { deps } = setup({
      apiBaseUrl: { ok: false, reason: 'api-config-missing' },
      business: async () => allBusinessFailed('config-missing'),
      database: async () => {
        throw new CatalogMatchCountSourceError('config-missing');
      },
      catalog: async () => {
        throw new CatalogMatchCountSourceError('config-missing');
      },
    });

    const artifact = await collectKpis(deps);

    expect(artifact.results.map((r) => r.kpi)).toEqual(['report_collection_duration']);
    expect(artifact.omissions).toHaveLength(9);
    expect(artifact.omissions.every((o) => o.reason.length > 0)).toBe(true);
  });

  it('la duración de colecta cubre también la lectura de negocio y excluye la publicación', async () => {
    const { deps } = setup({ businessMs: 400 });

    // 120 + 80 de sondeos + 50 de consulta SQL + 400 de negocio = 0,65 s; no hay publicación.
    expect(valueOf(await collectKpis(deps), 'report_collection_duration')).toBe(0.65);
  });

  it('los motivos de negocio, incluido no-denominator, son códigos conocidos del lote', () => {
    for (const reason of ['no-denominator', 'invalid-value', 'invalid-result']) {
      expect(OMISSION_REASONS as readonly string[]).toContain(reason);
    }
  });

  it('las unidades y rangos de la fuente de negocio coinciden con los del catálogo', () => {
    for (const aggregate of BUSINESS_AGGREGATES) {
      const entry = KPI_CATALOG.find((kpi) => kpi.id === aggregate.kpi);

      expect(entry?.kind).toBe('business');
      expect(entry?.unit).toBe(aggregate.unit);

      if (Number.isFinite(aggregate.max)) {
        expect(entry?.rule).toMatchObject({ max: aggregate.max });
      } else {
        expect(entry?.rule).not.toHaveProperty('max');
      }
    }
  });
});
