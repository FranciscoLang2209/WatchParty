import { describe, it, expect, vi } from 'vitest';
import {
  collectKpis,
  readReporterApiBaseUrl,
  type ApiBaseUrlConfig,
  type CollectKpisDeps,
} from './collect-kpis.js';
import {
  CatalogMatchCountSourceError,
  type CatalogMatchCount,
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
  catalog?: () => Promise<CatalogMatchCount>;
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

  const readCatalogMatchCount = vi.fn<CollectKpisDeps['readCatalogMatchCount']>(async () => {
    clockMs += scenario.catalogMs ?? 50;
    return scenario.catalog ? scenario.catalog() : { value: 12, unit: '{match}' };
  });

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
    readCatalogMatchCount,
    // `vi.fn` pierde el genérico de la función: se vuelve a tipar para la dependencia.
    withProbeToken: withProbeToken as CollectKpisDeps['withProbeToken'],
    fetchFn,
    now: nowFn,
    monotonicMs: () => clockMs,
  };

  return { deps, fetchFn, readCatalogMatchCount, withProbeToken, nowFn };
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
      { kpi: 'health_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'catalog_read_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'auth_guard_up', kind: 'health', unit: '1', value: 1 },
      // 120 ms + 80 ms de sondeos + 50 ms de consulta SQL = 0,25 s.
      { kpi: 'report_collection_duration', kind: 'technical', unit: 's', value: 0.25 },
    ]);
    expect(artifact.results.every((result) => Number.isFinite(result.value))).toBe(true);
  });

  it('sondea /health y /matches y consulta el catálogo al corte T', async () => {
    const { deps, fetchFn, readCatalogMatchCount } = setup();

    const artifact = await collectKpis(deps);

    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/health`,
      `${BASE}/matches`,
      `${BASE}/matches`,
    ]);
    expect(readCatalogMatchCount).toHaveBeenCalledTimes(1);
    expect(readCatalogMatchCount.mock.calls[0]![0].toISOString()).toBe(artifact.cutoff);
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
    const { deps } = setup({ catalog: async () => ({ value: 0, unit: '{match}' }) });

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
    const { deps } = setup({ catalog: async () => ({ value, unit: '{match}' }) });

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
      { catalog: async () => ({ value: -1, unit: '{match}' }) },
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
        catalog: async (): Promise<CatalogMatchCount> => {
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
