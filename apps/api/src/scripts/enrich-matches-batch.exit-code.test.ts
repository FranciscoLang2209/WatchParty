import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const BLANK_ENV: Record<string, string> = Object.fromEntries(
  [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
    'WEB_ORIGIN',
    'API_FOOTBALL_BASE_URL',
    'API_FOOTBALL_KEY',
    'ENRICHMENT_BATCH',
    'ENRICHMENT_DRY_RUN',
  ].map((name) => [name, '']),
);

const SECRET = 'clave-de-prueba-que-no-debe-aparecer';

const VALID_ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_ANON_KEY: 'test-anon-key',
  WEB_ORIGIN: 'http://localhost:5173',
  API_FOOTBALL_BASE_URL: 'https://example.invalid',
  API_FOOTBALL_KEY: SECRET,
};

const MATCH_ID = '3f9c0c8e-1c1e-4a62-8f64-0a3f6f1a2b10';

/** Se ejecuta con node + tsx directamente (sin `pnpm`), así corre igual en Windows y en Linux. */
function run(extraEnv: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/enrich-matches-batch.ts'], {
    cwd: API_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...BLANK_ENV, ...extraEnv },
  });
}

describe('matches:enrich-batch — configuración inválida (código 2, sin consultar ni escribir)', () => {
  it('sin credenciales informa los nombres que faltan, nunca valores', () => {
    const result = run({ ENRICHMENT_BATCH: `${MATCH_ID}:1` });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SUPABASE_URL');
    expect(result.stderr).toContain('API_FOOTBALL_KEY');
    expect(result.stdout).not.toContain('Lote:');
  });

  it('un lote vacío se rechaza: no hay piloto por defecto', () => {
    const result = run({ ...VALID_ENV, ENRICHMENT_BATCH: '  ' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('vacío');
    expect(result.stdout).not.toContain('Lote:');
  });

  it('un lote mal formado o ambiguo se rechaza completo', () => {
    const result = run({ ...VALID_ENV, ENRICHMENT_BATCH: `${MATCH_ID}:1, ${MATCH_ID}:2, x:abc` });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('aparece más de una vez');
    expect(result.stdout).not.toContain('Lote:');
  });

  it('un valor de dry_run que no es true/false nunca se toma como «escribir»', () => {
    const result = run({
      ...VALID_ENV,
      ENRICHMENT_BATCH: `${MATCH_ID}:1`,
      ENRICHMENT_DRY_RUN: 'si',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ENRICHMENT_DRY_RUN');
    expect(result.stdout).not.toContain('Modo:');
  });

  it('no imprime la clave del proveedor en ningún caso', () => {
    const result = run({ ...VALID_ENV, ENRICHMENT_BATCH: '' });

    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });
});
