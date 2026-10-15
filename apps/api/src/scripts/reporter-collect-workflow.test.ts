import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

const WORKFLOWS_DIR = '../../../../.github/workflows/';

const REPORTER_PATH = fileURLToPath(
  new URL(`${WORKFLOWS_DIR}reporter-collect.yml`, import.meta.url),
);
const MATCHES_SYNC_PATH = fileURLToPath(
  new URL(`${WORKFLOWS_DIR}matches-sync.yml`, import.meta.url),
);

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: unknown;
}

interface Job {
  if?: string;
  environment?: string;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
  steps: WorkflowStep[];
}

interface Workflow {
  on: {
    schedule?: { cron: string }[];
    workflow_dispatch?: { inputs?: Record<string, { options?: string[]; type?: string }> };
    [event: string]: unknown;
  };
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

const source = readFileSync(REPORTER_PATH, 'utf8');
const workflow = parse(source) as Workflow;
const job = workflow.jobs.collect!;
const steps = job.steps;
const collectStep = steps.find((step) => step.run?.includes('reporter:collect'));
const uploadStep = steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));

// Misma expresión en el ambiente, la concurrencia y REPORTER_ENV: los tres siempre coinciden.
const ENV_EXPRESSION = "${{ github.event_name == 'schedule' && 'prod' || inputs.environment }}";

describe('workflow reporter-collect: disparo', () => {
  it('programa una corrida diaria a las 04:00 UTC (01:00 Argentina)', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '0 4 * * *' }]);
  });

  it('permite disparo manual eligiendo ambiente entre dev y prod', () => {
    const input = workflow.on.workflow_dispatch?.inputs?.environment;

    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(input?.type).toBe('choice');
    expect(input?.options).toEqual(['dev', 'prod']);
  });

  it('no se dispara con push ni pull_request (no expone secretos a ramas ajenas)', () => {
    expect(workflow.on).not.toHaveProperty('push');
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
  });

  it('la corrida programada queda inerte hasta activar REPORTER_SCHEDULE_ENABLED; la manual no', () => {
    expect(job.if).toBe(
      "${{ github.event_name != 'schedule' || vars.REPORTER_SCHEDULE_ENABLED == 'true' }}",
    );
  });

  it('no cambia el schedule deportivo de matches-sync', () => {
    const matchesSync = parse(readFileSync(MATCHES_SYNC_PATH, 'utf8')) as Workflow;

    expect(matchesSync.on.schedule).toEqual([{ cron: '17 6 * * *' }]);
  });
});

describe('workflow reporter-collect: ambientes aislados', () => {
  it('cada ambiente usa su propio GitHub Environment; la corrida programada es de prod', () => {
    expect(job.environment).toBe(`reporter-${ENV_EXPRESSION}`);
  });

  it('hay una sola corrida activa por ambiente y no cancela una en curso', () => {
    expect(job.concurrency?.group).toBe(`reporter-collect-${ENV_EXPRESSION}`);
    expect(job.concurrency?.['cancel-in-progress']).toBe(false);
    expect(workflow).not.toHaveProperty('concurrency');
  });

  it('el comando recibe el ambiente que corresponde', () => {
    expect(job.env?.REPORTER_ENV).toBe(ENV_EXPRESSION);
  });

  it('las credenciales vienen solo de secrets o variables del ambiente, sin valores literales', () => {
    const env = collectStep?.env ?? {};

    expect(env.REPORTER_DATABASE_URL).toBe('${{ secrets.REPORTER_DATABASE_URL }}');
    expect(env.REPORTER_DATABASE_CA_CERT).toBe('${{ secrets.REPORTER_DATABASE_CA_CERT }}');
    expect(env.REPORTER_API_BASE_URL).toBe('${{ vars.REPORTER_API_BASE_URL }}');
  });
});

describe('workflow reporter-collect: ejecución', () => {
  it('usa el mismo runtime que el CI: pnpm, Node del .nvmrc e instalación congelada', () => {
    expect(steps.some((step) => step.uses?.startsWith('pnpm/action-setup'))).toBe(true);

    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node'));

    expect(setupNode?.with?.['node-version-file']).toBe('.nvmrc');
    expect(steps.some((step) => step.run === 'pnpm install --frozen-lockfile')).toBe(true);
  });

  it('ejecuta exactamente el comando reporter:collect', () => {
    expect(collectStep?.run?.trim()).toBe('pnpm --filter @watchparty/api reporter:collect');
  });

  it('no enmascara errores: sin continue-on-error ni operadores que fuerzan éxito', () => {
    expect(job).not.toHaveProperty('continue-on-error');

    for (const step of steps) {
      expect(step).not.toHaveProperty('continue-on-error');
      expect(step.run ?? '').not.toMatch(/\|\|\s*(true|:|exit\s+0)|set \+e/);
    }
  });

  it('solo lee el repositorio', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });
});

describe('workflow reporter-collect: artifacts', () => {
  it('se suben siempre, incluso si la colección falla', () => {
    expect(uploadStep).toBeDefined();
    expect(uploadStep?.if).toBe('${{ always() }}');
    expect(steps.indexOf(uploadStep!)).toBeGreaterThan(steps.indexOf(collectStep!));
  });

  it('se sube solo el directorio de salida de la colección, no el repositorio ni archivos de entorno', () => {
    expect(collectStep?.env?.REPORTER_OUTPUT_DIR).toBe('${{ github.workspace }}/reporter-output');
    expect(uploadStep?.with?.path).toBe('reporter-output/');
  });

  it('el nombre identifica ambiente y corrida, y se conservan 30 días', () => {
    expect(uploadStep?.with?.name).toBe(
      'reporter-collection-${{ env.REPORTER_ENV }}-${{ github.run_id }}',
    );
    expect(uploadStep?.with?.['retention-days']).toBe(30);
  });
});

describe('workflow reporter-collect: sin publicación central', () => {
  it('no recibe ninguna credencial de la plataforma central ni de rol de servicio', () => {
    expect(source).not.toMatch(/REPORTER_CENTRAL/);
    expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|service_role/i);
    expect(source).not.toMatch(/PROJECT_KEY|PUBLISHABLE_KEY/);
  });

  it('no tiene ningún paso que publique', () => {
    for (const step of steps) {
      expect(`${step.name ?? ''} ${step.run ?? ''}`).not.toMatch(/publish|publicar|measurement/i);
    }
  });
});
