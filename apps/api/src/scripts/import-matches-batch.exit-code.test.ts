import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Vacías para que un `apps/api/.env` local no altere el resultado (Node no las pisa). */
const BLANK_ENV: Record<string, string> = Object.fromEntries(
  [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
    'WEB_ORIGIN',
    'FOOTBALL_DATA_ORG_BASE_URL',
    'FOOTBALL_DATA_ORG_API_KEY',
    'MATCHES_IMPORT_BATCH',
  ].map((name) => [name, '']),
);

function runImportCommand(extraEnv: Record<string, string>) {
  return spawnSync('pnpm', ['--filter', '@watchparty/api', 'matches:import-batch'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...BLANK_ENV, ...extraEnv },
  });
}

const PROVIDER_ENV = {
  FOOTBALL_DATA_ORG_BASE_URL: 'https://example.invalid',
  FOOTBALL_DATA_ORG_API_KEY: 'test-key',
};

describe('matches:import-batch — configuración', () => {
  it('sin las credenciales de Supabase de demo sale con 2 antes de consultar o escribir', () => {
    const result = runImportCommand(PROVIDER_ENV);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SUPABASE_URL');
    expect(result.stderr).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.stdout).not.toContain('Lote:');
  });

  it('un lote inválido sale con 2 sin consultar al proveedor', () => {
    const result = runImportCommand({
      ...PROVIDER_ENV,
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SUPABASE_ANON_KEY: 'test-anon-key',
      WEB_ORIGIN: 'http://localhost:5173',
      MATCHES_IMPORT_BATCH: 'CLI:2025',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fuera del plan');
    expect(result.stdout).not.toContain('Lote:');
  });
});
