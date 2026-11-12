import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW_PATH = fileURLToPath(
  new URL('../../../../.github/workflows/matches-enrich-batch.yml', import.meta.url),
);
const IMPORT_WORKFLOW_PATH = fileURLToPath(
  new URL('../../../../.github/workflows/matches-import-batch.yml', import.meta.url),
);

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
}

interface Workflow {
  on: {
    workflow_dispatch: {
      inputs: Record<
        string,
        { type?: string; default?: unknown; options?: string[]; required?: boolean }
      >;
    };
  };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { environment?: string; steps: WorkflowStep[] }>;
}

const source = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parse(source) as Workflow;
const importWorkflow = parse(readFileSync(IMPORT_WORKFLOW_PATH, 'utf8')) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const enrichStep = steps.find((step) => step.run?.includes('matches:enrich-batch'));
const installIndex = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');

describe('workflow matches-enrich-batch', () => {
  it('solo se dispara a mano (Actions → Run workflow)', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });

  it('comparte el grupo de concurrencia con la sincronización y la importación (cuota compartida)', () => {
    expect(workflow.concurrency.group).toBe(importWorkflow.concurrency.group);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('pide target (demo por defecto), batch obligatorio y dry_run activado por defecto', () => {
    const { inputs } = workflow.on.workflow_dispatch;

    expect(inputs.target).toMatchObject({
      type: 'choice',
      default: 'demo',
      options: ['demo', 'production'],
    });
    expect(inputs.batch).toMatchObject({ type: 'string', required: true });
    expect(inputs.dry_run).toMatchObject({ type: 'boolean', default: true, required: true });
  });

  it('corre en el entorno del destino elegido', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.environment).toBe(
        "${{ inputs.target == 'production' && 'Production' || 'demo' }}",
      );
    }
  });

  it('llama al comando de enriquecimiento (no al importador de fixtures) con los inputs por entorno', () => {
    expect(enrichStep?.run?.trim()).toBe('pnpm --filter @watchparty/api matches:enrich-batch');
    expect(enrichStep?.env?.ENRICHMENT_BATCH).toBe('${{ inputs.batch }}');
    expect(enrichStep?.env?.ENRICHMENT_DRY_RUN).toBe('${{ inputs.dry_run }}');
    expect(source).not.toContain('matches:import-batch');
    expect(source).not.toContain('matches:sync');
  });

  it('toma los secretos de Supabase según el destino y las credenciales del proveedor del entorno', () => {
    const env = enrichStep?.env ?? {};
    const pick = (production: string, demo: string) =>
      `\${{ secrets[inputs.target == 'production' && '${production}' || '${demo}'] }}`;

    expect(env.SUPABASE_URL).toBe(pick('SUPABASE_URL', 'DEMO_SUPABASE_URL'));
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(
      pick('SUPABASE_SERVICE_ROLE_KEY', 'DEMO_SUPABASE_SERVICE_ROLE_KEY'),
    );
    expect(env.SUPABASE_ANON_KEY).toBe(pick('SUPABASE_ANON_KEY', 'DEMO_SUPABASE_ANON_KEY'));
    expect(env.WEB_ORIGIN).toBe(pick('WEB_ORIGIN', 'DEMO_WEB_ORIGIN'));
    expect(env.API_FOOTBALL_BASE_URL).toBe('${{ secrets.API_FOOTBALL_BASE_URL }}');
    expect(env.API_FOOTBALL_KEY).toBe('${{ secrets.API_FOOTBALL_KEY }}');
  });

  it('rechaza un lote vacío en cualquier destino, antes de instalar', () => {
    const guardIndex = steps.findIndex(
      (step) => step.env?.ENRICHMENT_BATCH !== undefined && step.run?.includes('exit 1'),
    );
    const guard = steps[guardIndex];

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(installIndex);
    expect(guard?.if).toBeUndefined();
    expect(guard?.env).toEqual({ ENRICHMENT_BATCH: '${{ inputs.batch }}' });
  });

  it('en production exige correr desde main, antes de instalar', () => {
    const guardIndex = steps.findIndex((step) => step.if === "inputs.target == 'production'");
    const guard = steps[guardIndex];

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(installIndex);
    expect(guard?.run).toContain('refs/heads/main');
    expect(guard?.run).toMatch(/exit 1/);
  });

  it('corta antes de instalar si la URL de demo es la de producción', () => {
    const guardIndex = steps.findIndex((step) => step.run?.includes('DEMO_SUPABASE_URL'));

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(installIndex);
    expect(steps[guardIndex]?.if).toBe("inputs.target == 'demo'");
  });

  it('nunca interpola inputs ni secretos dentro de los scripts de shell', () => {
    for (const step of steps) {
      expect(step.run ?? '').not.toContain('${{');
    }
  });

  it('no imprime secretos ni enmascara errores', () => {
    for (const step of steps) {
      expect(step).not.toHaveProperty('continue-on-error');
      expect(step.run ?? '').not.toMatch(/\|\|\s*(true|:|exit\s+0)|set \+e|echo .*secrets/);
    }
  });
});
