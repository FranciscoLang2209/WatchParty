import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYNC_PROVIDER,
  loadFootballDataOrgEnv,
  loadSportsProviderEnv,
  resolveBackfillFrom,
  resolveSyncProvider,
} from './sports-provider-env.js';

describe('resolveSyncProvider', () => {
  it('sin MATCHES_SYNC_PROVIDER usa football-data-org', () => {
    expect(resolveSyncProvider({})).toBe('football-data-org');
    expect(DEFAULT_SYNC_PROVIDER).toBe('football-data-org');
  });

  it.each(['', '   '])('un valor vacío (%j) cuenta como no configurado', (value) => {
    expect(resolveSyncProvider({ MATCHES_SYNC_PROVIDER: value })).toBe('football-data-org');
  });

  it('acepta api-football de forma explícita, ignorando espacios', () => {
    expect(resolveSyncProvider({ MATCHES_SYNC_PROVIDER: ' api-football ' })).toBe('api-football');
  });

  it('rechaza un valor desconocido en vez de elegir un proveedor por su cuenta', () => {
    expect(() => resolveSyncProvider({ MATCHES_SYNC_PROVIDER: 'otro' })).toThrow(
      'MATCHES_SYNC_PROVIDER',
    );
  });
});

describe('loadFootballDataOrgEnv', () => {
  const VALID = {
    FOOTBALL_DATA_ORG_BASE_URL: ' https://api.football-data.org ',
    FOOTBALL_DATA_ORG_API_KEY: ' token ',
  };

  it('devuelve la base URL y el token sin espacios sobrantes', () => {
    expect(loadFootballDataOrgEnv(VALID)).toEqual({
      FOOTBALL_DATA_ORG_BASE_URL: 'https://api.football-data.org',
      FOOTBALL_DATA_ORG_API_KEY: 'token',
    });
  });

  it.each(['FOOTBALL_DATA_ORG_BASE_URL', 'FOOTBALL_DATA_ORG_API_KEY'])(
    'falla nombrando la variable que falta: %s',
    (name) => {
      const env = { ...VALID, [name]: undefined };

      expect(() => loadFootballDataOrgEnv(env)).toThrow(name);
    },
  );

  it('un valor de solo espacios cuenta como faltante', () => {
    expect(() => loadFootballDataOrgEnv({ ...VALID, FOOTBALL_DATA_ORG_API_KEY: '   ' })).toThrow(
      'FOOTBALL_DATA_ORG_API_KEY',
    );
  });
});

describe('loadSportsProviderEnv (API-Football)', () => {
  it('conserva su contrato: exige la base URL y la clave', () => {
    expect(() => loadSportsProviderEnv({ API_FOOTBALL_KEY: 'k' })).toThrow('API_FOOTBALL_BASE_URL');
    expect(
      loadSportsProviderEnv({ API_FOOTBALL_BASE_URL: 'https://x', API_FOOTBALL_KEY: 'k' }),
    ).toEqual({ API_FOOTBALL_BASE_URL: 'https://x', API_FOOTBALL_KEY: 'k' });
  });
});

describe('resolveBackfillFrom (WAT-274)', () => {
  it('sin valor o en blanco no hay recuperación', () => {
    expect(resolveBackfillFrom({})).toBeUndefined();
    expect(resolveBackfillFrom({ MATCHES_SYNC_BACKFILL_FROM: '  ' })).toBeUndefined();
  });

  it('acepta una fecha YYYY-MM-DD válida', () => {
    expect(resolveBackfillFrom({ MATCHES_SYNC_BACKFILL_FROM: ' 2026-10-17 ' })).toBe('2026-10-17');
  });

  it.each(['17/10/2026', '2026-10-17T00:00:00Z', '2026-02-30', 'ayer'])('rechaza %s', (value) => {
    expect(() => resolveBackfillFrom({ MATCHES_SYNC_BACKFILL_FROM: value })).toThrow(
      'MATCHES_SYNC_BACKFILL_FROM',
    );
  });
});
