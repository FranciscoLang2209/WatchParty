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
  jobs: Record<string, { steps: WorkflowStep[] }>;
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

  it('toma las credenciales solo de secrets y no enmascara errores', () => {
    for (const [name, value] of Object.entries(importStep?.env ?? {})) {
      if (name === 'MATCHES_IMPORT_BATCH') continue;
      expect(value).toBe(`\${{ secrets.${name} }}`);
    }
    for (const step of steps) {
      expect(step).not.toHaveProperty('continue-on-error');
    }
  });
});
