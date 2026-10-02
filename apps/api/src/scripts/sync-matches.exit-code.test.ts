import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Ejecuta el comando real como lo hace el workflow, con un entorno mínimo y
 * controlado. Ningún caso llega a la red: todos fallan en validación de
 * configuración antes de crear clientes.
 */
function runSyncCommand(extraEnv: Record<string, string>) {
  return spawnSync('pnpm', ['--filter', '@watchparty/api', 'matches:sync'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...extraEnv,
    },
  });
}

const SUPABASE_ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  WEB_ORIGIN: 'http://localhost:5173',
};

describe('matches:sync — propagación del código de salida', () => {
  it('sale con código 2 y sin imprimir secretos si falta la configuración del proveedor', () => {
    const result = runSyncCommand(SUPABASE_ENV);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('API_FOOTBALL_BASE_URL');
    expect(result.stdout + result.stderr).not.toContain(SUPABASE_ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('sale con código distinto de 0 si falta la configuración de Supabase', () => {
    const result = runSyncCommand({
      API_FOOTBALL_BASE_URL: 'https://example.invalid',
      API_FOOTBALL_KEY: 'test-key',
    });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });
});
