import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseMatchStore } from './supabase-match-store.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';

type FakeResult = { data: unknown; error: { message: string } | null };

/**
 * Doble mínimo de un PostgrestFilterBuilder: cada método de encadenado
 * devuelve el mismo builder (registrando los args recibidos) y es
 * "thenable" para soportar tanto `await client.from(...).select(...)`
 * (sin terminal, como en list()) como el uso con `.single()`/`.maybeSingle()`.
 * No hay tipos reales de PostgREST acá a propósito: es un doble de test, no
 * un cliente real.
 */
function makeQueryBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (resolve: (value: FakeResult) => unknown) => resolve(result),
  };
  return builder;
}

interface FakeClientHandlers {
  matches?: () => FakeResult;
  rpc?: (fn: string, params: Record<string, unknown>) => FakeResult;
}

function makeFakeClient(handlers: FakeClientHandlers) {
  const fromCalls: string[] = [];

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    if (table === 'matches') {
      return makeQueryBuilder(handlers.matches?.() ?? { data: null, error: null });
    }
    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  const rpc = vi.fn(
    async (fn: string, params: Record<string, unknown>) =>
      handlers.rpc?.(fn, params) ?? { data: null, error: null },
  );

  return { from, rpc, fromCalls };
}

/** Vista del doble como SupabaseClient, solo para pasarlo al constructor del store. */
function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

const FIXTURE: NormalizedMatchFixture = {
  provider: 'local-fixtures',
  externalId: 'match-1',
  homeTeam: { externalId: 'team-1', name: 'Club Atlético Norte' },
  awayTeam: { externalId: 'team-2', name: 'Deportivo Sur' },
  competitionExternalId: 'liga-local',
  season: '2026',
  kickoffAt: '2026-09-06T21:00:00Z',
  status: 'scheduled',
};

describe('SupabaseMatchStore', () => {
  describe('list()', () => {
    it('reconstruye Match desde las relaciones embebidas y normaliza kickoffAt a "Z"', async () => {
      const client = makeFakeClient({
        matches: () => ({
          data: [
            {
              id: 'a1111111-1111-1111-1111-111111111111',
              kickoff_at: '2026-09-06T21:00:00+00:00',
              status: 'scheduled',
              home_team: { name: 'Club Atlético Norte' },
              away_team: { name: 'Deportivo Sur' },
            },
          ],
          error: null,
        }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      const matches = await store.list();

      expect(matches).toEqual([
        {
          id: 'a1111111-1111-1111-1111-111111111111',
          homeTeam: 'Club Atlético Norte',
          awayTeam: 'Deportivo Sur',
          kickoffAt: '2026-09-06T21:00:00.000Z',
          status: 'scheduled',
        },
      ]);
    });

    it('propaga un error de Supabase como SupabasePersistenceError (nunca [])', async () => {
      const client = makeFakeClient({
        matches: () => ({ data: null, error: { message: 'conexión perdida' } }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      await expect(store.list()).rejects.toThrow(SupabasePersistenceError);
    });
  });

  describe('findById()', () => {
    it('devuelve el Match cuando existe', async () => {
      const client = makeFakeClient({
        matches: () => ({
          data: {
            id: 'a1111111-1111-1111-1111-111111111111',
            kickoff_at: '2026-09-06T21:00:00Z',
            status: 'live',
            home_team: { name: 'Club Atlético Norte' },
            away_team: { name: 'Deportivo Sur' },
          },
          error: null,
        }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      const match = await store.findById('a1111111-1111-1111-1111-111111111111');

      expect(match).toEqual({
        id: 'a1111111-1111-1111-1111-111111111111',
        homeTeam: 'Club Atlético Norte',
        awayTeam: 'Deportivo Sur',
        kickoffAt: '2026-09-06T21:00:00.000Z',
        status: 'live',
      });
    });

    it('devuelve null cuando no existe (nunca lanza por un id inexistente)', async () => {
      const client = makeFakeClient({ matches: () => ({ data: null, error: null }) });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      await expect(store.findById('no-existe')).resolves.toBeNull();
    });

    it('propaga un error de Supabase como SupabasePersistenceError (nunca null)', async () => {
      const client = makeFakeClient({
        matches: () => ({ data: null, error: { message: 'timeout' } }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      await expect(store.findById('x')).rejects.toThrow(SupabasePersistenceError);
    });
  });

  describe('upsertFixture()', () => {
    it('delega en la función upsert_match_fixture con los datos planos del fixture', async () => {
      const client = makeFakeClient({
        rpc: () => ({ data: 'match-uuid', error: null }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      const matchId = await store.upsertFixture(FIXTURE);

      expect(matchId).toBe('match-uuid');
      // El adaptador ya no toca teams/matches directamente: la atomicidad de
      // guardar equipos + partido vive en la función de Postgres (ver
      // supabase/migrations/20260910120000_upsert_match_fixture_function.sql),
      // no en el orden de llamadas HTTP desde acá.
      expect(client.fromCalls).toEqual([]);
      expect(client.rpc).toHaveBeenCalledWith('upsert_match_fixture', {
        p_provider: 'local-fixtures',
        p_external_id: 'match-1',
        p_home_team_external_id: 'team-1',
        p_home_team_name: 'Club Atlético Norte',
        p_away_team_external_id: 'team-2',
        p_away_team_name: 'Deportivo Sur',
        p_competition_external_id: 'liga-local',
        p_season: '2026',
        p_kickoff_at: '2026-09-06T21:00:00Z',
        p_status: 'scheduled',
      });
    });

    it('propaga un error de Supabase como SupabasePersistenceError', async () => {
      const client = makeFakeClient({
        rpc: () => ({ data: null, error: { message: 'home_team_id = away_team_id' } }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      await expect(store.upsertFixture(FIXTURE)).rejects.toThrow(SupabasePersistenceError);
    });
  });

  describe('lease de sincronización', () => {
    it('acquireSyncLease llama al RPC con los parámetros del scope y devuelve el token', async () => {
      const client = makeFakeClient({
        rpc: () => ({ data: 'lease-token-abc', error: null }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      const token = await store.acquireSyncLease(
        { provider: 'api-football', competitionExternalId: 'liga-1', season: '2026' },
        'sync-worker-1',
      );

      expect(token).toBe('lease-token-abc');
      expect(client.rpc).toHaveBeenCalledWith('acquire_provider_sync_lease', {
        p_provider: 'api-football',
        p_competition_external_id: 'liga-1',
        p_season: '2026',
        p_owner: 'sync-worker-1',
      });
    });

    it('acquireSyncLease devuelve null cuando el lease ya está tomado', async () => {
      const client = makeFakeClient({ rpc: () => ({ data: null, error: null }) });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      const token = await store.acquireSyncLease(
        { provider: 'api-football', competitionExternalId: 'liga-1', season: '2026' },
        'sync-worker-2',
      );

      expect(token).toBeNull();
    });

    it('reclaimExpiredSyncLease, releaseSyncLease y recordSyncResult coercionan la respuesta a boolean', async () => {
      const client = makeFakeClient({ rpc: () => ({ data: true, error: null }) });
      const store = new SupabaseMatchStore(asSupabaseClient(client));
      const scope = { provider: 'api-football', competitionExternalId: 'liga-1', season: '2026' };

      await expect(store.reclaimExpiredSyncLease(scope)).resolves.toBe(true);
      await expect(store.releaseSyncLease(scope, 'token-1')).resolves.toBe(true);
      await expect(store.recordSyncResult(scope, 'token-1', true)).resolves.toBe(true);
    });

    it('propaga un error de RPC en cualquier operación de lease', async () => {
      const client = makeFakeClient({
        rpc: () => ({ data: null, error: { message: 'rpc falló' } }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));
      const scope = { provider: 'api-football', competitionExternalId: 'liga-1', season: '2026' };

      await expect(store.acquireSyncLease(scope, 'w')).rejects.toThrow(SupabasePersistenceError);
      await expect(store.releaseSyncLease(scope, 'token-1')).rejects.toThrow(
        SupabasePersistenceError,
      );
      await expect(store.reclaimExpiredSyncLease(scope)).rejects.toThrow(SupabasePersistenceError);
      await expect(store.recordSyncResult(scope, 'token-1', false)).rejects.toThrow(
        SupabasePersistenceError,
      );
    });
  });
});
