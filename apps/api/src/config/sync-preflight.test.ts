import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  API_FOOTBALL_ENV_REQUIREMENTS,
  FOOTBALL_DATA_ORG_ENV_REQUIREMENTS,
  SUPABASE_ENV_REQUIREMENTS,
  checkSyncEnv,
  syncEnvRequirements,
} from './sync-preflight.js';

const ALL_REQUIREMENTS = syncEnvRequirements('football-data-org');

const VALID_ENV: NodeJS.ProcessEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
  SUPABASE_ANON_KEY: 'anon-secret',
  WEB_ORIGIN: 'https://app.example.com',
  FOOTBALL_DATA_ORG_BASE_URL: 'https://api.football-data.org',
  FOOTBALL_DATA_ORG_API_KEY: 'provider-secret',
};

describe('checkSyncEnv — configuración válida', () => {
  it('acepta un entorno completo', () => {
    expect(checkSyncEnv(VALID_ENV, ALL_REQUIREMENTS)).toEqual({ ok: true });
  });
});

describe('checkSyncEnv — configuración incompleta', () => {
  it('informa juntas todas las variables faltantes', () => {
    const result = checkSyncEnv({}, ALL_REQUIREMENTS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(ALL_REQUIREMENTS.map(({ name }) => name));
    expect(result.message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.message).toContain('FOOTBALL_DATA_ORG_API_KEY');
  });

  it('trata valores vacíos o solo espacios como faltantes', () => {
    const result = checkSyncEnv(
      { ...VALID_ENV, SUPABASE_SERVICE_ROLE_KEY: '   ', FOOTBALL_DATA_ORG_API_KEY: '' },
      ALL_REQUIREMENTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY', 'FOOTBALL_DATA_ORG_API_KEY']);
  });

  it('rechaza URLs inválidas o con protocolo no http(s)', () => {
    const result = checkSyncEnv(
      { ...VALID_ENV, SUPABASE_URL: 'no-es-una-url', FOOTBALL_DATA_ORG_BASE_URL: 'ftp://host' },
      ALL_REQUIREMENTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid.map(({ name }) => name)).toEqual([
      'SUPABASE_URL',
      'FOOTBALL_DATA_ORG_BASE_URL',
    ]);
  });

  it('nunca incluye valores de las credenciales en el mensaje', () => {
    const result = checkSyncEnv(
      { ...VALID_ENV, SUPABASE_URL: 'no-es-una-url', FOOTBALL_DATA_ORG_API_KEY: '' },
      ALL_REQUIREMENTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const secret of ['service-role-secret', 'anon-secret', 'no-es-una-url']) {
      expect(result.message).not.toContain(secret);
    }
  });
});

describe('credenciales independientes y sin exposición al frontend', () => {
  it('mantiene separados los requisitos de Supabase y de cada proveedor', () => {
    const supabase = new Set(SUPABASE_ENV_REQUIREMENTS.map(({ name }) => name));

    for (const group of [FOOTBALL_DATA_ORG_ENV_REQUIREMENTS, API_FOOTBALL_ENV_REQUIREMENTS]) {
      expect(group.some(({ name }) => supabase.has(name))).toBe(false);
    }
  });

  it('exige solo las credenciales del proveedor seleccionado', () => {
    const names = (provider: 'football-data-org' | 'api-football') =>
      syncEnvRequirements(provider).map(({ name }) => name);

    expect(names('football-data-org')).toContain('FOOTBALL_DATA_ORG_API_KEY');
    expect(names('football-data-org')).not.toContain('API_FOOTBALL_KEY');
    expect(names('api-football')).toContain('API_FOOTBALL_KEY');
    expect(names('api-football')).not.toContain('FOOTBALL_DATA_ORG_API_KEY');
  });

  it('rechaza un requisito con nombre VITE_*', () => {
    expect(() => checkSyncEnv(VALID_ENV, [{ name: 'VITE_SUPABASE_SERVICE_ROLE_KEY' }])).toThrow(
      /VITE_/,
    );
  });

  it('ningún VITE_* del frontend nombra claves de servicio o del proveedor', () => {
    const webSrc = fileURLToPath(new URL('../../../web/src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(path)) files.push(path);
      }
    };
    walk(webSrc);

    const forbidden = /VITE_\w*(SERVICE_ROLE|FOOTBALL|API_KEY)\w*/;
    const offenders = files.filter((file) => forbidden.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
