import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseMatchStore } from './supabase-match-store.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';
import { SupabaseSyncLeaseStore } from './supabase-sync-lease-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';

// Reemplazamos SupabaseSyncLeaseStore por un doble: la casuística real de
// cada método de lease (parámetros del RPC, coerción a boolean, propagación
// de errores) ya está probada en supabase-sync-lease-store.test.ts. Acá solo
// nos importa una cosa distinta: que SupabaseMatchStore efectivamente le
// delega el trabajo, sin repetir esos mismos casos dos veces.
vi.mock('./supabase-sync-lease-store.js', () => ({
  SupabaseSyncLeaseStore: vi.fn().mockImplementation(function () {
    return {
      acquireSyncLease: vi.fn(async () => 'delegated-token'),
      reclaimExpiredSyncLease: vi.fn(async () => true),
      releaseSyncLease: vi.fn(async () => true),
      recordSyncResult: vi.fn(async () => true),
    };
  }),
}));

type FakeResult = { data: unknown; error: { message: string } | null };

function makeQueryBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (resolve: (value: FakeResult) => unknown) => resolve(result),
  };
  return builder;
}

interface FakeClientHandlers {
  teams?: (callNumber: number) => FakeResult;
  matches?: () => FakeResult;
}

function makeFakeClient(handlers: FakeClientHandlers) {
  let teamCallCount = 0;
  const fromCalls: string[] = [];

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    if (table === 'teams') {
      teamCallCount += 1;
      return makeQueryBuilder(handlers.teams?.(teamCallCount) ?? { data: null, error: null });
    }
    if (table === 'matches') {
      return makeQueryBuilder(handlers.matches?.() ?? { data: null, error: null });
    }
    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  return { from, fromCalls };
}

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
    it('upsertea ambos equipos antes que el partido, con onConflict (provider, external_id)', async () => {
      const client = makeFakeClient({
        teams: (call) => ({
          data: { id: call === 1 ? 'home-team-uuid' : 'away-team-uuid' },
          error: null,
        }),
        matches: () => ({ data: { id: 'match-uuid' }, error: null }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      const matchId = await store.upsertFixture(FIXTURE);

      expect(matchId).toBe('match-uuid');
      expect(client.fromCalls).toEqual(['teams', 'teams', 'matches']);

      const teamBuilder = client.from.mock.results[0]!.value as {
        upsert: ReturnType<typeof vi.fn>;
      };
      expect(teamBuilder.upsert).toHaveBeenCalledWith(
        { provider: 'local-fixtures', external_id: 'team-1', name: 'Club Atlético Norte' },
        { onConflict: 'provider,external_id' },
      );

      const matchBuilder = client.from.mock.results[2]!.value as {
        upsert: ReturnType<typeof vi.fn>;
      };
      expect(matchBuilder.upsert.mock.calls[0]![0]).not.toHaveProperty('id');
    });

    it('propaga el error si falla el upsert de un equipo, sin intentar el del partido', async () => {
      const client = makeFakeClient({
        teams: () => ({ data: null, error: { message: 'nombre de equipo vacío' } }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      await expect(store.upsertFixture(FIXTURE)).rejects.toThrow(SupabasePersistenceError);
      expect(client.fromCalls).toEqual(['teams']);
    });

    it('propaga el error si falla el upsert del partido', async () => {
      const client = makeFakeClient({
        teams: () => ({ data: { id: 'team-uuid' }, error: null }),
        matches: () => ({ data: null, error: { message: 'home_team_id = away_team_id' } }),
      });
      const store = new SupabaseMatchStore(asSupabaseClient(client));

      await expect(store.upsertFixture(FIXTURE)).rejects.toThrow(SupabasePersistenceError);
    });
  });

  describe('lease de sincronización: delega en SupabaseSyncLeaseStore', () => {
    it('construye el SupabaseSyncLeaseStore con el mismo client', () => {
      const client = makeFakeClient({});

      new SupabaseMatchStore(asSupabaseClient(client));

      expect(SupabaseSyncLeaseStore).toHaveBeenCalledWith(asSupabaseClient(client));
    });

    it('delega cada uno de los 4 métodos, argumentos y resultado incluidos', async () => {
      const client = makeFakeClient({});
      const store = new SupabaseMatchStore(asSupabaseClient(client));
      const leaseStoreInstance = vi.mocked(SupabaseSyncLeaseStore).mock.results.at(-1)!
        .value as Record<string, ReturnType<typeof vi.fn>>;
      const scope = { provider: 'api-football', competitionExternalId: 'liga-1', season: '2026' };

      await expect(store.acquireSyncLease(scope, 'worker', 60)).resolves.toBe('delegated-token');
      expect(leaseStoreInstance.acquireSyncLease).toHaveBeenCalledWith(scope, 'worker', 60);

      await expect(store.reclaimExpiredSyncLease(scope)).resolves.toBe(true);
      expect(leaseStoreInstance.reclaimExpiredSyncLease).toHaveBeenCalledWith(scope);

      await expect(store.releaseSyncLease(scope, 'token-1')).resolves.toBe(true);
      expect(leaseStoreInstance.releaseSyncLease).toHaveBeenCalledWith(scope, 'token-1');

      await expect(store.recordSyncResult(scope, 'token-1', true)).resolves.toBe(true);
      expect(leaseStoreInstance.recordSyncResult).toHaveBeenCalledWith(
        scope,
        'token-1',
        true,
        undefined,
      );
    });
  });
});
