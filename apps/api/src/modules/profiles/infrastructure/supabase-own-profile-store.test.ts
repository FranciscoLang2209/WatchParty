import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseOwnProfileStore } from './supabase-own-profile-store.js';
import { ProfilePersistenceError } from './profile-persistence-error.js';

type FakeResult = { data: unknown; error: { message: string } | null };

/**
 * Doble mínimo de un PostgrestFilterBuilder, mismo criterio que
 * `supabase-match-store.test.ts` (WAT-106): cada método de encadenado
 * devuelve el mismo builder (vía `vi.fn`, para poder aserirse sobre los
 * argumentos) y es "thenable" para `await client.from(...).select(...)`
 * sin terminal (como en `listTeams`).
 */
function makeQueryBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (value: FakeResult) => unknown) => resolve(result),
  };
  return builder;
}

interface FakeClientHandlers {
  profiles?: () => FakeResult;
  teams?: () => FakeResult;
}

function makeFakeClient(handlers: FakeClientHandlers) {
  const builders: Record<string, ReturnType<typeof makeQueryBuilder>> = {};

  const from = vi.fn((table: string) => {
    if (table === 'profiles') {
      builders.profiles = makeQueryBuilder(handlers.profiles?.() ?? { data: null, error: null });
      return builders.profiles;
    }
    if (table === 'teams') {
      builders.teams = makeQueryBuilder(handlers.teams?.() ?? { data: null, error: null });
      return builders.teams;
    }
    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  return { from, builders };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

const USER_ID = 'a1111111-1111-1111-1111-111111111111';
const TEAM_ID = 'b2222222-2222-2222-2222-222222222222';

describe('SupabaseOwnProfileStore', () => {
  describe('getOwnProfile()', () => {
    it('devuelve el Profile cuando existe, proyectando solo los tres campos públicos', async () => {
      const client = makeFakeClient({
        profiles: () => ({
          data: { display_name: 'Ignacio', bio: 'Hincha de River', favorite_team_id: TEAM_ID },
          error: null,
        }),
      });
      const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

      const profile = await store.getOwnProfile(USER_ID);

      expect(profile).toEqual({
        displayName: 'Ignacio',
        bio: 'Hincha de River',
        favoriteTeamId: TEAM_ID,
      });
      expect(client.builders.profiles?.select).toHaveBeenCalledWith(
        'display_name, bio, favorite_team_id',
      );
      expect(client.builders.profiles?.eq).toHaveBeenCalledWith('user_id', USER_ID);
    });

    it('devuelve null cuando la persona todavía no completó su perfil (no es un error)', async () => {
      const client = makeFakeClient({ profiles: () => ({ data: null, error: null }) });
      const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

      await expect(store.getOwnProfile(USER_ID)).resolves.toBeNull();
    });

    it('propaga un error de Supabase como ProfilePersistenceError sanitizado (nunca null)', async () => {
      const client = makeFakeClient({
        profiles: () => ({ data: null, error: { message: 'conexión perdida a public.profiles' } }),
      });
      const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

      const rejection = expect(store.getOwnProfile(USER_ID)).rejects;
      await rejection.toThrow(ProfilePersistenceError);
      await rejection.not.toThrow('conexión perdida a public.profiles');
    });
  });

  describe('listTeams()', () => {
    it('proyecta solo {id, name}, ordenado por nombre y luego por id de forma determinista', async () => {
      const rows = [
        { id: 'team-1', name: 'Boca Juniors' },
        { id: 'team-2', name: 'River Plate' },
      ];
      const client = makeFakeClient({ teams: () => ({ data: rows, error: null }) });
      const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

      const teams = await store.listTeams();

      expect(teams).toEqual(rows);
      expect(client.builders.teams?.select).toHaveBeenCalledWith('id, name');
      expect(client.builders.teams?.order).toHaveBeenNthCalledWith(1, 'name', {
        ascending: true,
      });
      expect(client.builders.teams?.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('propaga un error de Supabase como ProfilePersistenceError (nunca [] silencioso)', async () => {
      const client = makeFakeClient({
        teams: () => ({ data: null, error: { message: 'timeout' } }),
      });
      const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

      await expect(store.listTeams()).rejects.toThrow(ProfilePersistenceError);
    });
  });
});
