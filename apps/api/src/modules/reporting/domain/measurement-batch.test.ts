import { describe, it, expect } from 'vitest';
import {
  MAX_BATCH_ROWS,
  buildMeasurementBatch,
  serializeArchive,
  serializeBatchPayload,
  toArgentinaDate,
  validateMeasurementBatch,
  type BuildBatchInput,
  type BuildResult,
  type MeasurementRow,
  type ReportBatch,
  type SerializeResult,
} from './measurement-batch.js';

// Todos los datos de este archivo son SIMULADOS: no provienen de ninguna fuente
// real y no acreditan reporting operativo.
const SIMULATED_RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SIMULATED_RUN_ID = '22222222-2222-4222-8222-222222222222';
const SIMULATED_CUTOFF = new Date('2026-10-14T15:00:00Z');

const FORBIDDEN_FIELDS = ['project_id', 'reported_at', 'team_id', 'status', 'measured_at'];

const SIMULATED_RESULTS = [
  { kpi: 'catalog_match_count', value: 4210 },
  { kpi: 'health_response_latency', value: 312.456 },
  { kpi: 'catalog_query_latency', value: 41.5 },
  { kpi: 'health_up', value: 1 },
  { kpi: 'database_up', value: 1 },
  { kpi: 'catalog_read_up', value: 1 },
  { kpi: 'auth_guard_up', value: 1 },
  { kpi: 'report_collection_duration', value: 1.591 },
];

function input(overrides: Partial<BuildBatchInput> = {}): BuildBatchInput {
  return {
    env: 'dev',
    cutoff: SIMULATED_CUTOFF,
    runId: SIMULATED_RUN_ID,
    results: SIMULATED_RESULTS,
    omissions: [],
    simulated: true,
    ...overrides,
  };
}

function built(result: BuildResult) {
  if (!result.ok) throw new Error(`Se esperaba un lote válido: ${JSON.stringify(result.issues)}`);
  return result.batch;
}

function jsonOf(result: SerializeResult): string {
  if (!result.ok) throw new Error(`Se esperaba un JSON: ${JSON.stringify(result.issues)}`);
  return result.json;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    kpi_id: 'catalog_match_count',
    date: '2026-10-14',
    env: 'dev',
    value: 4210,
    run_id: SIMULATED_RUN_ID,
    ...overrides,
  };
}

function codes(result: { ok: boolean; issues?: { code: string }[] }) {
  return result.issues?.map((issue) => issue.code) ?? [];
}

describe('toArgentinaDate: fecha local del corte T', () => {
  it.each([
    ['2026-10-14T15:00:00.000Z', '2026-10-14'],
    ['2026-10-14T02:59:59.999Z', '2026-10-13'], // último instante del día anterior en Argentina
    ['2026-10-14T03:00:00.000Z', '2026-10-14'], // 00:00 en Argentina
    ['2026-10-14T04:00:00.000Z', '2026-10-14'], // 01:00 en Argentina, hora de la corrida programada
    ['2026-10-15T02:59:59.999Z', '2026-10-14'],
    ['2026-12-31T23:59:59.999Z', '2026-12-31'],
    ['2027-01-01T02:59:59.999Z', '2026-12-31'], // borde de año
    ['2027-01-01T03:00:00.000Z', '2027-01-01'],
    ['2028-02-29T02:59:59.999Z', '2028-02-28'], // borde de año bisiesto
    ['2028-02-29T03:00:00.000Z', '2028-02-29'],
  ])('el corte %s cae en %s', (cutoff, expected) => {
    expect(toArgentinaDate(new Date(cutoff))).toBe(expected);
  });

  it('lanza ante una fecha inválida', () => {
    expect(() => toArgentinaDate(new Date('no es una fecha'))).toThrow('corte');
  });
});

describe('buildMeasurementBatch: todas las fuentes válidas', () => {
  it('arma una fila por KPI con exactamente los campos del contrato', () => {
    const batch = built(buildMeasurementBatch(input()));

    expect(batch.rows).toHaveLength(8);

    for (const row of batch.rows) {
      expect(Object.keys(row)).toEqual(['kpi_id', 'date', 'env', 'value', 'run_id']);
    }

    expect(batch.rows.map((r) => [r.kpi_id, r.value])).toEqual([
      ['catalog_match_count', 4210],
      ['health_response_latency', 312.456],
      ['catalog_query_latency', 41.5],
      ['health_up', 1],
      ['database_up', 1],
      ['catalog_read_up', 1],
      ['auth_guard_up', 1],
      ['report_collection_duration', 1.591],
    ]);
  });

  it('el payload no incluye ningún campo que asigna el servidor ni prohibido', () => {
    const batch = built(buildMeasurementBatch(input()));
    const payload = jsonOf(serializeBatchPayload(batch.rows));

    for (const field of FORBIDDEN_FIELDS) {
      expect(payload).not.toContain(field);
    }
  });

  it('todas las filas comparten el mismo run_id, env y date', () => {
    const batch = built(buildMeasurementBatch(input({ env: 'prod' })));

    expect(new Set(batch.rows.map((r) => r.run_id))).toEqual(new Set([SIMULATED_RUN_ID]));
    expect(new Set(batch.rows.map((r) => r.env))).toEqual(new Set(['prod']));
    expect(new Set(batch.rows.map((r) => r.date))).toEqual(new Set(['2026-10-14']));
  });

  it('está completo y sin fallo visible', () => {
    const batch = built(buildMeasurementBatch(input()));

    expect(batch.complete).toBe(true);
    expect(batch.visible_failure).toBe(false);
    expect(batch.omissions).toEqual([]);
  });

  it.each([
    ['2026-10-14T02:59:59.999Z', '2026-10-13'],
    ['2026-10-14T03:00:00.000Z', '2026-10-14'],
  ])('date es la fecha local de Argentina del corte %s', (cutoff, date) => {
    const batch = built(buildMeasurementBatch(input({ cutoff: new Date(cutoff) })));

    expect(new Set(batch.rows.map((r) => r.date))).toEqual(new Set([date]));
    expect(batch.cutoff).toBe(new Date(cutoff).toISOString());
    expect(batch.date).toBe(date);
  });

  it('cero es un valor válido cuando la fuente lo informó', () => {
    const batch = built(
      buildMeasurementBatch(
        input({
          results: [
            { kpi: 'catalog_match_count', value: 0 },
            { kpi: 'health_up', value: 0 },
          ],
        }),
      ),
    );

    expect(batch.rows.map((r) => r.value)).toEqual([0, 0]);
  });
});

describe('buildMeasurementBatch: fuente inválida se omite con motivo', () => {
  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['texto numérico', '12'],
  ])('un valor %s se omite como invalid-value y no se envía', (_label, value) => {
    const batch = built(
      buildMeasurementBatch(
        input({
          results: SIMULATED_RESULTS.map((r) => (r.kpi === 'health_up' ? { ...r, value } : r)),
        }),
      ),
    );

    expect(batch.rows.map((r) => r.kpi_id)).not.toContain('health_up');
    expect(batch.omissions).toEqual([{ kpi_id: 'health_up', reason: 'invalid-value' }]);
    expect(jsonOf(serializeBatchPayload(batch.rows))).not.toContain('null');
  });

  it.each([
    ['catalog_match_count', -1],
    ['catalog_match_count', 1.5],
    ['health_response_latency', -5],
    ['health_up', 2],
    ['auth_guard_up', -1],
    ['report_collection_duration', -0.5],
  ])('%s con %d está fuera de rango y se omite', (kpi, value) => {
    const batch = built(
      buildMeasurementBatch(
        input({ results: SIMULATED_RESULTS.map((r) => (r.kpi === kpi ? { ...r, value } : r)) }),
      ),
    );

    expect(batch.omissions).toEqual([{ kpi_id: kpi, reason: 'invalid-value' }]);
    expect(batch.rows).toHaveLength(7);
  });

  it('un KPI omitido por el colector conserva su motivo y no se vuelve cero', () => {
    const batch = built(
      buildMeasurementBatch(
        input({
          results: SIMULATED_RESULTS.filter((r) => r.kpi !== 'catalog_match_count'),
          omissions: [{ kpi: 'catalog_match_count', reason: 'permission-denied' }],
        }),
      ),
    );

    expect(batch.omissions).toEqual([
      { kpi_id: 'catalog_match_count', reason: 'permission-denied' },
    ]);
    expect(batch.rows.map((r) => r.kpi_id)).not.toContain('catalog_match_count');
  });

  it('un KPI sin valor ni motivo se omite como not-collected', () => {
    const batch = built(
      buildMeasurementBatch(
        input({ results: SIMULATED_RESULTS.filter((r) => r.kpi !== 'auth_guard_up') }),
      ),
    );

    expect(batch.omissions).toEqual([{ kpi_id: 'auth_guard_up', reason: 'not-collected' }]);
  });

  it('con menos fuentes válidas que KPIs el lote sale, pero incompleto y con fallo visible', () => {
    const batch = built(
      buildMeasurementBatch(
        input({
          results: SIMULATED_RESULTS.slice(0, 4),
          omissions: [{ kpi: 'report_collection_duration', reason: 'invalid-value' }],
        }),
      ),
    );

    expect(batch.rows).toHaveLength(4);
    expect(batch.complete).toBe(false);
    expect(batch.visible_failure).toBe(true);
  });

  it('sin ninguna fuente válida no hay lote que enviar, pero se conservan los motivos', () => {
    const result = buildMeasurementBatch(
      input({
        results: [],
        omissions: [{ kpi: 'catalog_match_count', reason: 'config-missing' }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['empty-batch']);
    expect(!result.ok && result.omissions).toHaveLength(8);
    expect(!result.ok && result.omissions[0]).toEqual({
      kpi_id: 'catalog_match_count',
      reason: 'config-missing',
    });
  });
});

describe('buildMeasurementBatch: lote inválido', () => {
  it.each([
    ['ambiente desconocido', { env: 'staging' as never }, 'invalid-env'],
    ['corte inválido', { cutoff: new Date('x') }, 'invalid-cutoff'],
    ['run_id que no es UUID', { runId: 'no-es-un-uuid' }, 'invalid-run-id'],
    ['run_id vacío', { runId: '' }, 'invalid-run-id'],
  ])('%s impide armar el lote', (_label, overrides, code) => {
    const result = buildMeasurementBatch(input(overrides));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(code);
  });

  it('un KPI fuera del catálogo impide armar todo el lote', () => {
    const result = buildMeasurementBatch(
      input({ results: [...SIMULATED_RESULTS, { kpi: 'rated_match_rate', value: 50 }] }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['unknown-kpi']);
  });

  it('un KPI repetido impide armar todo el lote', () => {
    const result = buildMeasurementBatch(
      input({ results: [...SIMULATED_RESULTS, { kpi: 'health_up', value: 0 }] }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['duplicate-kpi']);
  });

  it('un KPI con valor y omitido a la vez es ambiguo e impide armar el lote', () => {
    const result = buildMeasurementBatch(
      input({ omissions: [{ kpi: 'health_up', reason: 'timeout' }] }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['duplicate-kpi']);
  });
});

describe('validateMeasurementBatch', () => {
  it('acepta un lote válido y devuelve solo los cinco campos', () => {
    const result = validateMeasurementBatch([row()]);

    expect(result).toEqual({ ok: true, rows: [row()] });
  });

  it.each(FORBIDDEN_FIELDS)('rechaza el campo %s', (field) => {
    const result = validateMeasurementBatch([row({ [field]: 'x' })]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([{ row: 0, code: 'forbidden-field', field }]);
  });

  it('rechaza cualquier otro campo extra sin reportar su contenido', () => {
    const result = validateMeasurementBatch([row({ token: 'secreto' })]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([{ row: 0, code: 'unexpected-field' }]);
    expect(JSON.stringify(result)).not.toContain('secreto');
  });

  it.each(['kpi_id', 'date', 'env', 'value', 'run_id'])('rechaza la falta de %s', (field) => {
    const incomplete: Record<string, unknown> = row();
    delete incomplete[field];

    const result = validateMeasurementBatch([incomplete]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toContainEqual({ row: 0, code: 'missing-field', field });
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
    ['texto', '12'],
    ['fuera de rango', -1],
  ])('rechaza un value %s', (_label, value) => {
    const result = validateMeasurementBatch([row({ value })]);

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['invalid-value']);
  });

  it('una sola fila inválida invalida todo el lote y no devuelve ninguna fila', () => {
    const result = validateMeasurementBatch([
      row({ kpi_id: 'health_up', value: 1 }),
      row({ kpi_id: 'auth_guard_up', value: 2 }),
      row({ kpi_id: 'catalog_match_count', value: 10 }),
    ]);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('rows');
    expect(!result.ok && result.issues).toEqual([{ row: 1, code: 'invalid-value' }]);
  });

  it('rechaza un KPI fuera del catálogo y uno repetido', () => {
    expect(codes(validateMeasurementBatch([row({ kpi_id: 'rated_match_rate' })]))).toEqual([
      'unknown-kpi',
    ]);
    expect(
      codes(
        validateMeasurementBatch([
          row({ kpi_id: 'health_up', value: 1 }),
          row({ kpi_id: 'health_up', value: 0 }),
        ]),
      ),
    ).toEqual(['duplicate-kpi']);
  });

  it.each([
    ['formato incorrecto', '14/10/2026'],
    ['mes inexistente', '2026-13-01'],
    ['día inexistente', '2026-02-30'],
    ['no es texto', 20261014],
  ])('rechaza una fecha inválida: %s', (_label, date) => {
    expect(codes(validateMeasurementBatch([row({ date })]))).toEqual(['invalid-date']);
  });

  it('acepta el 29 de febrero solo en año bisiesto', () => {
    expect(validateMeasurementBatch([row({ date: '2028-02-29' })]).ok).toBe(true);
    expect(codes(validateMeasurementBatch([row({ date: '2027-02-29' })]))).toEqual([
      'invalid-date',
    ]);
  });

  it.each(['staging', 'PROD', '', null])('rechaza el env %j', (env) => {
    expect(codes(validateMeasurementBatch([row({ env })]))).toEqual(['invalid-env']);
  });

  it('exige un UUID común: rechaza uno inválido y filas con run_id distintos', () => {
    expect(codes(validateMeasurementBatch([row({ run_id: 'no-uuid' })]))).toEqual([
      'invalid-run-id',
    ]);

    const mixed = validateMeasurementBatch([
      row({ kpi_id: 'health_up', value: 1 }),
      row({ kpi_id: 'auth_guard_up', value: 1, run_id: OTHER_SIMULATED_RUN_ID }),
    ]);

    expect(mixed.ok).toBe(false);
    expect(codes(mixed)).toEqual(['run-id-mismatch']);
  });

  it('exige env y date comunes a todo el lote', () => {
    const result = validateMeasurementBatch([
      row({ kpi_id: 'health_up', value: 1 }),
      row({ kpi_id: 'auth_guard_up', value: 1, env: 'prod', date: '2026-10-13' }),
    ]);

    expect(codes(result).sort()).toEqual(['date-mismatch', 'env-mismatch']);
  });

  it('rechaza lo que no es un lote: no-array, vacío o con más de 10 filas', () => {
    expect(codes(validateMeasurementBatch({}))).toEqual(['not-an-array']);
    expect(codes(validateMeasurementBatch([]))).toEqual(['empty-batch']);
    expect(MAX_BATCH_ROWS).toBe(10);
    expect(codes(validateMeasurementBatch(Array.from({ length: 11 }, () => row())))).toEqual([
      'too-many-rows',
    ]);
  });

  it('rechaza filas que no son objetos', () => {
    expect(codes(validateMeasurementBatch([null]))).toEqual(['not-an-object']);
    expect(codes(validateMeasurementBatch([[]]))).toEqual(['not-an-object']);
    expect(codes(validateMeasurementBatch(['x']))).toEqual(['not-an-object']);
  });
});

describe('serializeArchive: JSON y corte archivables', () => {
  it('conserva el corte, el resultado y los motivos, e identifica el artefacto como simulado', () => {
    const batch = built(
      buildMeasurementBatch(
        input({
          results: SIMULATED_RESULTS.filter((r) => r.kpi !== 'health_up'),
          omissions: [{ kpi: 'health_up', reason: 'timeout' }],
        }),
      ),
    );

    const archived = JSON.parse(jsonOf(serializeArchive(batch)));

    expect(Object.keys(archived)).toEqual([
      'cutoff',
      'date',
      'env',
      'run_id',
      'rows',
      'omissions',
      'complete',
      'visible_failure',
      'simulated',
    ]);
    expect(archived).toMatchObject({
      cutoff: '2026-10-14T15:00:00.000Z',
      date: '2026-10-14',
      env: 'dev',
      run_id: SIMULATED_RUN_ID,
      omissions: [{ kpi_id: 'health_up', reason: 'timeout' }],
      complete: false,
      visible_failure: true,
      simulated: true,
    });
  });

  it('un artefacto real no se marca como simulado por defecto', () => {
    const batch = built(buildMeasurementBatch(input({ simulated: undefined })));

    expect(batch.simulated).toBe(false);
  });

  it('el archivo solo contiene los campos del contrato en las filas y no lleva secretos', () => {
    const batch = built(buildMeasurementBatch(input()));
    const text = jsonOf(serializeArchive(batch));

    for (const archivedRow of JSON.parse(text).rows) {
      expect(Object.keys(archivedRow)).toEqual(['kpi_id', 'date', 'env', 'value', 'run_id']);
    }

    for (const field of FORBIDDEN_FIELDS) {
      expect(text).not.toContain(field);
    }

    expect(text).not.toMatch(/key|token|secret|password|authorization|apikey/i);
  });

  it('el payload a enviar sale del lote validado y es el mismo JSON que se archiva', () => {
    const batch = built(buildMeasurementBatch(input()));

    expect(JSON.parse(jsonOf(serializeBatchPayload(batch.rows)))).toEqual(
      JSON.parse(jsonOf(serializeArchive(batch))).rows,
    );
  });
});

describe('serializeBatchPayload: revalida siempre antes de serializar', () => {
  it('serializa un lote válido con una fila por KPI', () => {
    const rows = built(buildMeasurementBatch(input())).rows;

    expect(JSON.parse(jsonOf(serializeBatchPayload(rows)))).toHaveLength(8);
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
  ])(
    'rechaza el lote completo si una fila tiene value %s (no lo convierte en null)',
    (_l, value) => {
      const rows = [
        row({ kpi_id: 'health_up', value: 1 }),
        row({ kpi_id: 'auth_guard_up', value }),
      ];

      const result = serializeBatchPayload(rows);

      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('json');
      expect(!result.ok && result.issues).toEqual([{ row: 1, code: 'invalid-value' }]);
    },
  );

  it.each(FORBIDDEN_FIELDS)('rechaza el lote completo si una fila trae %s', (field) => {
    const rows = [
      row({ kpi_id: 'health_up', value: 1 }),
      row({ kpi_id: 'auth_guard_up', value: 1, [field]: 'x' }),
    ];

    const result = serializeBatchPayload(rows);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('json');
    expect(!result.ok && result.issues).toEqual([{ row: 1, code: 'forbidden-field', field }]);
  });

  it('rechaza lo que no es un lote válido, sea cual sea su origen', () => {
    expect(serializeBatchPayload({}).ok).toBe(false);
    expect(serializeBatchPayload([]).ok).toBe(false);
    expect(serializeBatchPayload([null]).ok).toBe(false);
    expect(serializeBatchPayload([row({ token: 'x' })]).ok).toBe(false);
  });

  it('las filas de un lote validado no se pueden modificar', () => {
    const batch = built(buildMeasurementBatch(input()));
    const first = batch.rows[0] as { value: number };

    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.rows)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      first.value = Number.NaN;
    }).toThrow(TypeError);
    expect(() => {
      (batch.rows as MeasurementRow[]).push(row() as unknown as MeasurementRow);
    }).toThrow(TypeError);
    expect(JSON.parse(jsonOf(serializeBatchPayload(batch.rows)))[0].value).toBe(4210);
  });

  it('un lote validado devuelve copias: modificar la entrada después no lo cambia', () => {
    const original = [row({ kpi_id: 'health_up', value: 1 })];
    const validated = validateMeasurementBatch(original);

    original[0]!.value = 0;
    (original[0] as Record<string, unknown>).project_id = 'x';

    expect(validated.ok && validated.rows[0]?.value).toBe(1);
    expect(serializeBatchPayload(original).ok).toBe(false);
  });

  it('una copia alterada de las filas se rechaza al serializar', () => {
    const rows = built(buildMeasurementBatch(input())).rows;
    const tampered = rows.map((r) => ({ ...r }));

    (tampered[2] as { value: number }).value = Number.NaN;
    (tampered[3] as Record<string, unknown>).project_id = 'x';

    const result = serializeBatchPayload(tampered);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([
      { row: 2, code: 'invalid-value' },
      { row: 3, code: 'forbidden-field', field: 'project_id' },
    ]);
  });
});

describe('motivos de omisión: solo códigos conocidos, sin secretos', () => {
  const SIMULATED_SECRET = 'SIMULATED_PASSWORD_123';
  const LEAKY_REASONS = [
    `connect failed: postgresql://watchparty_reporter:${SIMULATED_SECRET}@db.example.test:5432/postgres?sslmode=verify-full`,
    `Error: password authentication failed for user "x" (${SIMULATED_SECRET})`,
    `Bearer ${SIMULATED_SECRET}`,
    '',
    'cualquier texto libre',
  ];

  function withReason(reason: string) {
    return buildMeasurementBatch(
      input({
        results: SIMULATED_RESULTS.filter((r) => r.kpi !== 'catalog_match_count'),
        omissions: [{ kpi: 'catalog_match_count', reason }],
      }),
    );
  }

  it.each(LEAKY_REASONS)('un motivo desconocido (%#) se reemplaza por un código fijo', (reason) => {
    const batch = built(withReason(reason));

    expect(batch.omissions).toEqual([{ kpi_id: 'catalog_match_count', reason: 'unknown-reason' }]);
  });

  it('un error simulado con credenciales no aparece en el archivo ni en el payload', () => {
    const batch = built(withReason(LEAKY_REASONS[0]!));
    const archive = jsonOf(serializeArchive(batch));
    const payload = jsonOf(serializeBatchPayload(batch.rows));

    for (const text of [archive, payload, JSON.stringify(batch)]) {
      expect(text).not.toContain(SIMULATED_SECRET);
      expect(text).not.toContain('postgresql://');
      expect(text).not.toContain('example.test');
    }

    expect(JSON.parse(archive).omissions).toEqual([
      { kpi_id: 'catalog_match_count', reason: 'unknown-reason' },
    ]);
  });

  it('un motivo que no es texto tampoco llega al archivo', () => {
    const batch = built(
      buildMeasurementBatch(
        input({
          results: SIMULATED_RESULTS.filter((r) => r.kpi !== 'health_up'),
          omissions: [
            { kpi: 'health_up', reason: { secret: SIMULATED_SECRET } as unknown as string },
          ],
        }),
      ),
    );

    expect(jsonOf(serializeArchive(batch))).not.toContain(SIMULATED_SECRET);
    expect(batch.omissions[0]?.reason).toBe('unknown-reason');
  });

  it.each([
    'config-missing',
    'config-invalid',
    'connection-failed',
    'permission-denied',
    'query-failed',
    'invalid-result',
    'api-config-missing',
    'api-config-invalid',
    'timeout',
    'network-error',
    'not-200',
    'unexpected-status',
    'invalid-value',
    'unexpected-error',
  ])('el código conocido %s se conserva tal cual', (reason) => {
    const batch = built(withReason(reason));

    expect(batch.omissions).toEqual([{ kpi_id: 'catalog_match_count', reason }]);
  });

  it('un lote armado a mano o alterado no puede archivar texto libre', () => {
    const batch = built(withReason('timeout'));
    const forged = {
      ...batch,
      omissions: [{ kpi_id: 'catalog_match_count', reason: LEAKY_REASONS[0]! }],
    } as unknown as ReportBatch;

    const archive = jsonOf(serializeArchive(forged));

    expect(archive).not.toContain(SIMULATED_SECRET);
    expect(JSON.parse(archive).omissions[0].reason).toBe('unknown-reason');
  });

  it('el archivo se deriva de las filas validadas: no archiva campos sueltos del lote', () => {
    const batch = built(buildMeasurementBatch(input()));
    const forged = {
      ...batch,
      run_id: `postgresql://u:${SIMULATED_SECRET}@h/db`,
      env: SIMULATED_SECRET,
      date: SIMULATED_SECRET,
    } as unknown as ReportBatch;

    const archive = jsonOf(serializeArchive(forged));

    expect(archive).not.toContain(SIMULATED_SECRET);
    expect(JSON.parse(archive)).toMatchObject({
      run_id: SIMULATED_RUN_ID,
      env: 'dev',
      date: '2026-10-14',
    });
  });

  it('no archiva un lote con filas inválidas ni con un corte inválido', () => {
    const batch = built(buildMeasurementBatch(input()));
    const badRows = { ...batch, rows: [{ ...batch.rows[0]!, value: Number.NaN }] } as ReportBatch;
    const badCutoff = { ...batch, cutoff: 'no es una fecha' } as ReportBatch;

    expect(serializeArchive(badRows).ok).toBe(false);
    expect(serializeArchive(badCutoff).ok).toBe(false);
  });
});

describe('arrays con posiciones vacías (huecos)', () => {
  // `new Array(n)` y `[a, , b]` son arrays válidos para `Array.isArray` pero con
  // posiciones sin valor: `forEach` las omite y `map` las conserva.
  const withHoleInTheMiddle = () => {
    const rows: unknown[] = [row({ kpi_id: 'health_up', value: 1 })];

    rows.length = 3; // posición 1 vacía
    rows[2] = row({ kpi_id: 'auth_guard_up', value: 1 });

    return rows;
  };

  it('un array de una posición vacía no es un lote válido', () => {
    const result = validateMeasurementBatch(new Array(1));

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('rows');
    expect(!result.ok && result.issues).toEqual([{ row: 0, code: 'not-an-object' }]);
  });

  it('un hueco entre filas válidas invalida todo el lote y se informa en su posición', () => {
    const result = validateMeasurementBatch(withHoleInTheMiddle());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([{ row: 1, code: 'not-an-object' }]);
  });

  it('un hueco al final también se rechaza', () => {
    const rows: unknown[] = [row({ kpi_id: 'health_up', value: 1 })];

    rows.length = 2;

    expect(validateMeasurementBatch(rows).ok).toBe(false);
  });

  it('serializeBatchPayload rechaza el lote y no genera un JSON con null', () => {
    for (const rows of [new Array(1), withHoleInTheMiddle()]) {
      const result = serializeBatchPayload(rows);

      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('json');
    }
  });

  it('serializeArchive no lanza: rechaza el lote con huecos', () => {
    const batch = built(buildMeasurementBatch(input()));
    const sparse = { ...batch, rows: new Array(1) } as unknown as ReportBatch;

    expect(() => serializeArchive(sparse)).not.toThrow();
    expect(serializeArchive(sparse).ok).toBe(false);
  });
});
