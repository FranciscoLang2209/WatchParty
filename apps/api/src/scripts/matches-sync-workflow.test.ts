import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW_PATH = fileURLToPath(
  new URL('../../../../.github/workflows/matches-sync.yml', import.meta.url),
);

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
}

interface Workflow {
  on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { 'continue-on-error'?: unknown; if?: string; steps: WorkflowStep[] }>;
}

const source = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parse(source) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const syncStep = steps.find((step) => step.run?.includes('matches:sync'));

describe('workflow matches-sync (OPS-02)', () => {
  it('queda deshabilitado hasta activar explícitamente MATCHES_SYNC_ENABLED', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("${{ vars.MATCHES_SYNC_ENABLED == 'true' }}");
    }
  });
  it('programa una corrida diaria a las 06:17 UTC y permite disparo manual', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '17 6 * * *' }]);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('serializa las corridas sin cancelar una sincronización en curso', () => {
    expect(workflow.concurrency.group).toBeTruthy();
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('instala dependencias con lockfile congelado', () => {
    expect(steps.some((step) => step.run === 'pnpm install --frozen-lockfile')).toBe(true);
  });

  it('ejecuta exactamente el comando existente matches:sync', () => {
    expect(syncStep?.run?.trim()).toBe('pnpm --filter @watchparty/api matches:sync');
  });

  it('no enmascara errores: sin continue-on-error ni operadores que fuerzan éxito', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job).not.toHaveProperty('continue-on-error');
    }

    for (const step of steps) {
      expect(step).not.toHaveProperty('continue-on-error');
      expect(step.run ?? '').not.toMatch(/\|\|\s*(true|:|exit\s+0)|set \+e/);
    }
  });

  it('entrega las credenciales solo desde secrets, sin valores literales', () => {
    const env = syncStep?.env ?? {};
    const required = [
      'FOOTBALL_DATA_ORG_BASE_URL',
      'FOOTBALL_DATA_ORG_API_KEY',
      'API_FOOTBALL_BASE_URL',
      'API_FOOTBALL_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ANON_KEY',
      'WEB_ORIGIN',
    ];

    for (const name of required) {
      expect(env[name], name).toBe(`\${{ secrets.${name} }}`);
    }
  });

  it('el proveedor se elige con una variable de repositorio, sin valor literal', () => {
    expect(syncStep?.env?.MATCHES_SYNC_PROVIDER).toBe('${{ vars.MATCHES_SYNC_PROVIDER }}');
  });
});
