import { describe, expect, it, vi } from 'vitest';
import type { CollectionArtifact } from './collect-kpis.js';
import { ARCHIVE_FILE, PAYLOAD_FILE, RESULT_FILE, runReport } from './run-report.js';

// Todo lo de este archivo es SIMULADO: no proviene de ninguna fuente real.
const SIMULATED_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SIMULATED_SECRET = 'SIMULATED_PASSWORD_123';

function artifact(overrides: Partial<CollectionArtifact> = {}): CollectionArtifact {
  return {
    cutoff: '2026-10-14T04:00:00.000Z',
    localDate: '2026-10-14',
    results: [
      { kpi: 'catalog_match_count', kind: 'technical', unit: '{match}', value: 4210 },
      { kpi: 'health_response_latency', kind: 'technical', unit: 'ms', value: 312.456 },
      { kpi: 'catalog_query_latency', kind: 'technical', unit: 'ms', value: 41.5 },
      { kpi: 'health_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'auth_guard_up', kind: 'health', unit: '1', value: 1 },
      { kpi: 'report_collection_duration', kind: 'technical', unit: 's', value: 1.591 },
    ],
    omissions: [],
    ...overrides,
  };
}

async function run(collected: CollectionArtifact, env: 'dev' | 'prod' = 'dev') {
  return runReport({ env, runId: SIMULATED_RUN_ID, collect: async () => collected });
}

function parsed(files: Record<string, string>, name: string) {
  return JSON.parse(files[name]!) as Record<string, unknown>;
}

describe('runReport: todas las fuentes válidas', () => {
  it('sale con 0 y deja el JSON del lote, el corte T y el resultado', async () => {
    const { files, exitCode } = await run(artifact());

    expect(exitCode).toBe(0);
    expect(Object.keys(files).sort()).toEqual([ARCHIVE_FILE, PAYLOAD_FILE, RESULT_FILE].sort());
  });

  it('el JSON del lote tiene solo las filas del contrato, con el run_id común', async () => {
    const { files } = await run(artifact());
    const rows = JSON.parse(files[PAYLOAD_FILE]!) as Record<string, unknown>[];

    expect(rows).toHaveLength(6);

    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['kpi_id', 'date', 'env', 'value', 'run_id']);
      expect(row).toMatchObject({ date: '2026-10-14', env: 'dev', run_id: SIMULATED_RUN_ID });
    }
  });

  it('el archivo conserva el corte T, el ambiente y que no es simulado', async () => {
    const { files } = await run(artifact(), 'prod');

    expect(parsed(files, ARCHIVE_FILE)).toMatchObject({
      cutoff: '2026-10-14T04:00:00.000Z',
      date: '2026-10-14',
      env: 'prod',
      run_id: SIMULATED_RUN_ID,
      complete: true,
      visible_failure: false,
      simulated: false,
    });
  });

  it('el resultado dice que no se publicó nada', async () => {
    const { files } = await run(artifact());

    expect(parsed(files, RESULT_FILE)).toMatchObject({
      env: 'dev',
      run_id: SIMULATED_RUN_ID,
      cutoff: '2026-10-14T04:00:00.000Z',
      local_date: '2026-10-14',
      ok: true,
      complete: true,
      visible_failure: false,
      omissions: [],
      issues: [],
      published: false,
    });
  });

  it('la fecha es la local de Argentina del corte: 01:00 de Argentina es el mismo día', async () => {
    // La corrida de las 04:00 UTC ocurre a la 01:00 de Argentina: mismo día calendario.
    const { files } = await run(artifact({ cutoff: '2026-10-14T04:00:00.000Z' }));

    expect(JSON.parse(files[PAYLOAD_FILE]!)[0].date).toBe('2026-10-14');
  });

  it('un corte justo antes de las 03:00 UTC pertenece al día anterior en Argentina', async () => {
    const { files } = await run(artifact({ cutoff: '2026-10-14T02:59:59.999Z' }));

    expect(JSON.parse(files[PAYLOAD_FILE]!)[0].date).toBe('2026-10-13');
  });
});

describe('runReport: falta de fuentes = fallo visible, pero los archivos se conservan', () => {
  const withoutCatalog = () =>
    artifact({
      results: artifact().results.filter((r) => r.kpi !== 'catalog_match_count'),
      omissions: [{ kpi: 'catalog_match_count', reason: 'permission-denied' }],
    });

  it('con una fuente omitida sale con 1 y escribe todos los archivos', async () => {
    const { files, exitCode } = await run(withoutCatalog());

    expect(exitCode).toBe(1);
    expect(Object.keys(files).sort()).toEqual([ARCHIVE_FILE, PAYLOAD_FILE, RESULT_FILE].sort());
    expect(JSON.parse(files[PAYLOAD_FILE]!)).toHaveLength(5);
  });

  it('el resultado y el archivo conservan el motivo y marcan el fallo visible', async () => {
    const { files } = await run(withoutCatalog());

    expect(parsed(files, RESULT_FILE)).toMatchObject({
      ok: false,
      complete: false,
      visible_failure: true,
      omissions: [{ kpi_id: 'catalog_match_count', reason: 'permission-denied' }],
      published: false,
    });
    expect(parsed(files, ARCHIVE_FILE)).toMatchObject({ complete: false, visible_failure: true });
  });

  it('sin ninguna fuente válida no hay lote, pero el resultado conserva todos los motivos', async () => {
    const { files, exitCode } = await run(
      artifact({
        results: [],
        omissions: [
          { kpi: 'catalog_match_count', reason: 'config-missing' },
          { kpi: 'health_response_latency', reason: 'api-config-missing' },
          { kpi: 'catalog_query_latency', reason: 'config-missing' },
          { kpi: 'health_up', reason: 'api-config-missing' },
          { kpi: 'auth_guard_up', reason: 'api-config-missing' },
          { kpi: 'report_collection_duration', reason: 'invalid-value' },
        ],
      }),
    );

    expect(exitCode).toBe(1);
    expect(Object.keys(files)).toEqual([RESULT_FILE]);

    const result = parsed(files, RESULT_FILE);

    expect(result).toMatchObject({ ok: false, visible_failure: true });
    expect(result.issues).toEqual([{ row: null, code: 'empty-batch' }]);
    expect(result.omissions).toHaveLength(6);
    expect(result.omissions).toContainEqual({
      kpi_id: 'catalog_match_count',
      reason: 'config-missing',
    });
  });

  it('un lote que no se puede armar (KPI fuera del catálogo) también falla de forma visible', async () => {
    const { files, exitCode } = await run(
      artifact({
        results: [
          ...artifact().results,
          { kpi: 'rated_match_rate' as never, kind: 'business' as never, unit: '%', value: 50 },
        ],
      }),
    );

    expect(exitCode).toBe(1);
    expect(files[PAYLOAD_FILE]).toBeUndefined();
    expect(parsed(files, RESULT_FILE)).toMatchObject({ ok: false, visible_failure: true });
  });

  it('si el colector lanza, el error se propaga (no se inventa un resultado)', async () => {
    await expect(
      runReport({
        env: 'dev',
        runId: SIMULATED_RUN_ID,
        collect: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    ).rejects.toThrow('boom');
  });
});

describe('runReport: los archivos no contienen secretos', () => {
  it('un motivo con credenciales no llega a ningún archivo', async () => {
    const leaky = `connect failed: postgresql://watchparty_reporter:${SIMULATED_SECRET}@db.example.test/postgres`;
    const { files } = await run(
      artifact({
        results: artifact().results.filter((r) => r.kpi !== 'catalog_match_count'),
        omissions: [{ kpi: 'catalog_match_count', reason: leaky }],
      }),
    );

    for (const content of Object.values(files)) {
      expect(content).not.toContain(SIMULATED_SECRET);
      expect(content).not.toContain('postgresql://');
      expect(content).not.toContain('db.example.test');
    }

    expect(parsed(files, RESULT_FILE).omissions).toEqual([
      { kpi_id: 'catalog_match_count', reason: 'unknown-reason' },
    ]);
  });

  it('un motivo con credenciales tampoco llega al resultado cuando no se arma el lote', async () => {
    const leaky = `Bearer ${SIMULATED_SECRET}`;
    const { files } = await run(
      artifact({
        results: [],
        omissions: [{ kpi: 'catalog_match_count', reason: leaky }],
      }),
    );

    expect(files[RESULT_FILE]).not.toContain(SIMULATED_SECRET);
  });

  it('ningún archivo menciona claves, tokens ni la clave de la plataforma central', async () => {
    const { files } = await run(artifact());

    for (const content of Object.values(files)) {
      expect(content).not.toMatch(/apikey|x-project-key|service_role|password|secret|token/i);
    }
  });
});
