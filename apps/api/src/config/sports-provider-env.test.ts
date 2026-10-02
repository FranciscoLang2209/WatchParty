import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYNC_PROVIDER,
  loadFootballDataOrgEnv,
  loadSportsProviderEnv,
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
