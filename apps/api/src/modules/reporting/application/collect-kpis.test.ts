import { describe, it, expect, vi } from 'vitest';
import {
  collectKpis,
  readReporterApiBaseUrl,
  type ApiBaseUrlConfig,
  type CollectKpisDeps,
} from './collect-kpis.js';
import {
  CatalogMatchCountSourceError,
  type CatalogQueryRead,
} from '../infrastructure/catalog-match-count-source.js';
import { KPI_CATALOG } from '../domain/kpi-catalog.js';
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
  catalogMs?: number;
  now?: Date;
}

/** Una lectura del catálogo: el conteo y cuánto tardó la consulta que lo trajo. */
function catalogRead(value: number, queryDurationMs = 35.1234): CatalogQueryRead {
  return { count: { value, unit: '{match}' }, queryDurationMs };
}

function setup(scenario: Scenario = {}) {
  let clockMs = 5_000;

  const fetchFn = vi.fn<typeof fetch>(async (url) => {
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

  const nowFn = vi.fn(() => scenario.now ?? NOW);

  const deps: CollectKpisDeps = {
    apiBaseUrl: scenario.apiBaseUrl ?? { ok: true, baseUrl: BASE },
    readCatalog,
    fetchFn,
    now: nowFn,
    monotonicMs: () => clockMs,
  };

  return { deps, fetchFn, readCatalog, nowFn };
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
      { kpi: 'catalog_match_count', kind: 'technical', unit: '{match}', value: 12 },
      { kpi: 'health_response_latency', kind: 'technical', unit: 'ms', value: 120 },
      { kpi: 'catalog_query_latency', kind: 'technical', unit: 'ms', value: 35.123 },
      { kpi: 'health_up', kind: 'health', unit: '1', value: 1 },
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
    '%s omite los tres KPIs HTTP sin hacer ninguna petición',
    async (reason) => {
      const { deps, fetchFn } = setup({ apiBaseUrl: { ok: false, reason } });

      const artifact = await collectKpis(deps);

      expect(fetchFn).not.toHaveBeenCalled();
      expect(artifact.omissions).toEqual([
        { kpi: 'health_response_latency', reason },
        { kpi: 'health_up', reason },
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
      catalog: async () => {
        throw new CatalogMatchCountSourceError('connection-failed');
      },
    });

    const artifact = await collectKpis(deps);

    expect(artifact.results.map((result) => result.kpi)).toEqual(['report_collection_duration']);
    expect(artifact.omissions).toHaveLength(5);
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
    expect(batch.ok && batch.batch.rows).toHaveLength(6);
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

    expect(batch.ok && batch.batch.rows).toHaveLength(5);
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
