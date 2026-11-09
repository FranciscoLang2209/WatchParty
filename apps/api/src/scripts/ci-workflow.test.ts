import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

const ROOT = '../../../../';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`${ROOT}${relative}`, import.meta.url)), 'utf8');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  'continue-on-error'?: unknown;
}

interface Workflow {
  on: Record<string, unknown>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { 'continue-on-error'?: unknown; steps: WorkflowStep[] }>;
}

const workflow = parse(read('.github/workflows/ci.yml')) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const stepByRun = (command: string) => steps.find((step) => step.run === command);

describe('workflow CI — qué corre en cada evento', () => {
  it('conserva el job quality, por lo que el check sigue siendo «CI / quality»', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['quality']);
  });

  it('se dispara en push, pull_request y de forma manual', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
  });

  it('formato, lint y typecheck corren en todos los eventos, push incluido', () => {
    for (const command of ['pnpm format', 'pnpm lint', 'pnpm typecheck']) {
      const step = stepByRun(command);

      expect(step, command).toBeDefined();
      expect(step).not.toHaveProperty('if');
    }
  });

  it('tests y build quedan fuera del push a ramas y corren en pull_request, en main y en la ejecución manual', () => {
    for (const command of ['pnpm test', 'pnpm build']) {
      expect(stepByRun(command)?.if, command).toBe(
        "github.event_name != 'push' || github.ref == 'refs/heads/main'",
      );
    }
  });

  it('instala dependencias con lockfile congelado antes de cualquier control', () => {
    const install = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
    const primerControl = steps.findIndex((step) => step.run === 'pnpm format');

    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(primerControl);
  });

  it('conserva el cache de pnpm y la cancelación de corridas obsoletas por ref', () => {
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node'));

    expect(setupNode?.with?.cache).toBe('pnpm');
    expect(workflow.concurrency.group).toBe('${{ github.workflow }}-${{ github.ref }}');
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
  });

  it('no oculta fallos: sin continue-on-error ni operadores que fuerzan éxito', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job).not.toHaveProperty('continue-on-error');
    }

    for (const step of steps) {
      expect(step).not.toHaveProperty('continue-on-error');
      expect(step.run ?? '').not.toMatch(/\|\|\s*(true|:|exit\s+0)|set \+e/);
    }
  });
});

describe('validación local — pnpm validate y hook pre-push', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it('pnpm validate encadena formato, lint, tipos, tests y build, en ese orden', () => {
    expect(scripts.validate?.split(' && ')).toEqual([
      'pnpm format',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
    ]);
  });

  it('el hook pre-push ejecuta pnpm validate y nada más', () => {
    const comandos = read('.husky/pre-push')
      .split(/\r?\n/)
      .map((linea) => linea.trim())
      .filter((linea) => linea !== '' && !linea.startsWith('#'));

    expect(comandos).toEqual(['pnpm validate']);
  });

  it('el pre-commit sigue siendo liviano: sólo lint-staged', () => {
    expect(read('.husky/pre-commit').trim()).toBe('pnpm exec lint-staged');
  });
});
