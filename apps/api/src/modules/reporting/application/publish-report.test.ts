import { describe, expect, it, vi } from 'vitest';
import { KPI_CATALOG } from '../domain/kpi-catalog.js';
import { publishReport } from './publish-report.js';

const rows = KPI_CATALOG.map(({ id }) => ({
  kpi_id: id,
  date: '2026-10-15',
  env: 'prod',
  value: 1,
  run_id: '11111111-1111-4111-8111-111111111111',
}));
const env = {
  REPORTER_CENTRAL_URL: 'https://central.example.test',
  REPORTER_CENTRAL_PUBLISHABLE_KEY: 'SIMULATED_PUBLIC_KEY',
  REPORTER_CENTRAL_PROJECT_KEY: 'SIMULATED_PROJECT_KEY',
};

function setup(
  options: { team?: number; environment?: string; received?: unknown; postStatus?: number } = {},
) {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    if (init?.body === '{}') {
      return Response.json([
        { team_number: options.team ?? 5, env: options.environment ?? 'prod' },
      ]);
    }
    if (init?.method === 'POST') return new Response(null, { status: options.postStatus ?? 201 });
    return Response.json(options.received ?? rows);
  });
  return { env, fetchFn };
}

describe('publishReport', () => {
  it('verifica el equipo y ambiente antes de publicar y confirma los cinco valores por GET', async () => {
    const deps = setup();
    expect(await publishReport(rows, 'prod', deps)).toMatchObject({ ok: true, verified: true });
    expect(deps.fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'https://central.example.test/rest/v1/rpc/current_project',
      'https://central.example.test/rest/v1/measurement?on_conflict=project_id,kpi_id,date,env',
      'https://central.example.test/rest/v1/measurement?select=kpi_id%2Cdate%2Cenv%2Cvalue%2Crun_id&date=eq.2026-10-15&env=eq.prod',
    ]);
  });

  it.each([{ team: 6 }, { environment: 'dev' }])(
    'no publica con una clave ajena o de otro ambiente: %j',
    async (options) => {
      const deps = setup(options);
      expect(await publishReport(rows, 'prod', deps)).toMatchObject({
        reason: 'identity-mismatch',
      });
      expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it('rechaza lotes parciales y ambientes cruzados antes de usar credenciales', async () => {
    const deps = setup();
    expect(await publishReport(rows.slice(1), 'prod', deps)).toMatchObject({
      reason: 'invalid-batch',
    });
    expect(await publishReport(rows, 'dev', deps)).toMatchObject({ reason: 'env-mismatch' });
    expect(deps.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    rows.slice(1),
    rows.map((row, index) => (index === 0 ? { ...row, value: 2 } : row)),
    rows.map((row) => ({ ...row, run_id: '22222222-2222-4222-8222-222222222222' })),
  ])('un 201 no acredita valores faltantes, distintos ni de otra corrida', async (received) => {
    const result = await publishReport(rows, 'prod', setup({ received }));
    expect(result).toMatchObject({
      ok: false,
      verified: false,
      reason: 'received-values-mismatch',
    });
    expect(result.publication?.ok).toBe(true);
  });

  it('un rechazo de publicación falla sin declarar recepción', async () => {
    const deps = setup({ postStatus: 409 });
    expect(await publishReport(rows, 'prod', deps)).toMatchObject({
      ok: false,
      verified: false,
      reason: 'client-error',
    });
    expect(deps.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('no persiste mensajes de red ni claves en los resultados', async () => {
    const deps = setup();
    deps.fetchFn.mockRejectedValueOnce(new Error('SIMULATED_PROJECT_KEY'));
    const result = await publishReport(rows, 'prod', deps);
    expect(result.reason).toBe('identity-check-failed');
    expect(JSON.stringify(result)).not.toContain('SIMULATED_PROJECT_KEY');
  });
});
