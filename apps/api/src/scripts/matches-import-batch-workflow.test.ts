import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW_PATH = fileURLToPath(
  new URL('../../../../.github/workflows/matches-import-batch.yml', import.meta.url),
);
const SYNC_WORKFLOW_PATH = fileURLToPath(
  new URL('../../../../.github/workflows/matches-sync.yml', import.meta.url),
);

interface WorkflowStep {
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
}

interface Workflow {
  on: Record<string, unknown>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { environment?: string; steps: WorkflowStep[] }>;
}

const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
const syncWorkflow = parse(readFileSync(SYNC_WORKFLOW_PATH, 'utf8')) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const importStep = steps.find((step) => step.run?.includes('matches:import-batch'));

describe('workflow matches-import-batch', () => {
  it('solo se dispara a mano', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });

  it('comparte el grupo de concurrencia con la sincronización diaria', () => {
    expect(workflow.concurrency.group).toBe(syncWorkflow.concurrency.group);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('ejecuta el comando de importación con el lote del input', () => {
    expect(importStep?.run?.trim()).toBe('pnpm --filter @watchparty/api matches:import-batch');
    expect(importStep?.env?.MATCHES_IMPORT_BATCH).toBe('${{ inputs.batch }}');
  });

  it('corre en el entorno de GitHub Actions de demo', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.environment).toBe('demo');
    }
  });

  it('escribe en Supabase de demo con secretos DEMO_*, nunca con los de producción', () => {
    const env = importStep?.env ?? {};
    expect(env.SUPABASE_URL).toBe('${{ secrets.DEMO_SUPABASE_URL }}');
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('${{ secrets.DEMO_SUPABASE_SERVICE_ROLE_KEY }}');
    expect(env.SUPABASE_ANON_KEY).toBe('${{ secrets.DEMO_SUPABASE_ANON_KEY }}');
    expect(env.WEB_ORIGIN).toBe('${{ secrets.DEMO_WEB_ORIGIN }}');
    expect(env.FOOTBALL_DATA_ORG_BASE_URL).toBe('${{ secrets.FOOTBALL_DATA_ORG_BASE_URL }}');
    expect(env.FOOTBALL_DATA_ORG_API_KEY).toBe('${{ secrets.FOOTBALL_DATA_ORG_API_KEY }}');
  });

  it('corta antes de instalar si la URL de demo es la de producción', () => {
    const guardIndex = steps.findIndex((step) => step.run?.includes('DEMO_SUPABASE_URL'));
    const installIndex = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(installIndex);
    expect(steps[guardIndex]?.env).toEqual({
      DEMO_SUPABASE_URL: '${{ secrets.DEMO_SUPABASE_URL }}',
      PRODUCTION_SUPABASE_URL: '${{ secrets.SUPABASE_URL }}',
    });
  });

  it('no enmascara errores', () => {
    for (const step of steps) {
      expect(step).not.toHaveProperty('continue-on-error');
      expect(step.run ?? '').not.toMatch(/\|\|\s*(true|:|exit\s+0)|set \+e/);
    }
  });
});
