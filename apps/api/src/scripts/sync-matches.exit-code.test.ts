import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * El script carga `apps/api/.env` (`--env-file-if-exists`), y Node no pisa una
 * variable ya definida, ni siquiera vacía. Se definen vacías para que un `.env`
 * local no altere el resultado del test.
 */
const BLANK_ENV: Record<string, string> = Object.fromEntries(
  [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
    'WEB_ORIGIN',
    'FOOTBALL_DATA_ORG_BASE_URL',
    'FOOTBALL_DATA_ORG_API_KEY',
    'API_FOOTBALL_BASE_URL',
    'API_FOOTBALL_KEY',
    'MATCHES_SYNC_PROVIDER',
  ].map((name) => [name, '']),
);

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
      ...BLANK_ENV,
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
  it('sale con código 2 y sin imprimir secretos si falta la configuración del proveedor por defecto', () => {
    const result = runSyncCommand(SUPABASE_ENV);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('FOOTBALL_DATA_ORG_BASE_URL');
    expect(result.stdout + result.stderr).not.toContain(SUPABASE_ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('con MATCHES_SYNC_PROVIDER=api-football exige la configuración de API-Football', () => {
    const result = runSyncCommand({ ...SUPABASE_ENV, MATCHES_SYNC_PROVIDER: 'api-football' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('API_FOOTBALL_BASE_URL');
  });

  it('un MATCHES_SYNC_PROVIDER desconocido sale con código 2 sin elegir un proveedor', () => {
    const result = runSyncCommand({ ...SUPABASE_ENV, MATCHES_SYNC_PROVIDER: 'otro' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('MATCHES_SYNC_PROVIDER');
  });

  it('sale con código distinto de 0 si falta la configuración de Supabase', () => {
    const result = runSyncCommand({
      FOOTBALL_DATA_ORG_BASE_URL: 'https://example.invalid',
      FOOTBALL_DATA_ORG_API_KEY: 'test-key',
    });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });
  it('sale con código 2 nombrando lo que falta si no hay configuración de Supabase', () => {
    const result = runSyncCommand({
      FOOTBALL_DATA_ORG_BASE_URL: 'https://example.invalid',
      FOOTBALL_DATA_ORG_API_KEY: 'test-key',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
