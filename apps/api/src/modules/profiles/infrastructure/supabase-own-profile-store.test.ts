import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseOwnProfileStore } from './supabase-own-profile-store.js';
import { ProfilePersistenceError } from './profile-persistence-error.js';
import { ProfileValidationError } from '../domain/profile-validation-error.js';

type FakeResult = { data: unknown; error: { message: string } | null };

/**
 * Doble mínimo de un PostgrestFilterBuilder, mismo criterio que
 * `supabase-match-store.test.ts` (WAT-106): cada método de encadenado
 * devuelve el mismo builder (vía `vi.fn`, para poder aserirse sobre los
 * argumentos) y es "thenable" para `await client.from(...).select(...)`
 * sin terminal (como en `listTeams`).
 */

interface FakeClientHandlers {
  profiles?: () => FakeResult;
  teams?: () => FakeResult;
}

function makeQueryBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (resolve: (value: FakeResult) => unknown) => resolve(result),
  };
  return builder;
}

interface FakeClientHandlers {
  profiles?: () => FakeResult;
  teams?: () => FakeResult;
}

function makeFakeClient(handlers: FakeClientHandlers) {
  const fromCalls: string[] = [];
  const builders: Record<string, ReturnType<typeof makeQueryBuilder>> = {};

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
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

  return { from, fromCalls, builders };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

const USER_ID = 'a1111111-1111-1111-1111-111111111111';
const TEAM_ID = 'b2222222-2222-2222-2222-222222222222';

describe('saveOwnProfile()', () => {
  const VALID_INPUT = {
    displayName: '  Ignacio  ',
    bio: 'Hincha de River',
    favoriteTeamId: TEAM_ID,
  };

  it('alta: upsertea por user_id con el nombre recortado y devuelve el Profile persistido', async () => {
    const client = makeFakeClient({
      teams: () => ({ data: { id: TEAM_ID }, error: null }),
      profiles: () => ({
        data: { display_name: 'Ignacio', bio: 'Hincha de River', favorite_team_id: TEAM_ID },
        error: null,
      }),
    });
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    const profile = await store.saveOwnProfile(USER_ID, VALID_INPUT);

    expect(profile).toEqual({
      displayName: 'Ignacio',
      bio: 'Hincha de River',
      favoriteTeamId: TEAM_ID,
    });
    expect(client.builders.profiles?.upsert).toHaveBeenCalledWith(
      {
        user_id: USER_ID,
        display_name: 'Ignacio',
        bio: 'Hincha de River',
        favorite_team_id: TEAM_ID,
      },
      { onConflict: 'user_id' },
    );
  });

  it('edición: mismo camino de upsert cuando ya existía un perfil', async () => {
    const client = makeFakeClient({
      teams: () => ({ data: { id: TEAM_ID }, error: null }),
      profiles: () => ({
        data: { display_name: 'Nacho', bio: 'Actualizado', favorite_team_id: TEAM_ID },
        error: null,
      }),
    });
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    const profile = await store.saveOwnProfile(USER_ID, {
      displayName: 'Nacho',
      bio: 'Actualizado',
      favoriteTeamId: TEAM_ID,
    });

    expect(profile.displayName).toBe('Nacho');
    expect(client.builders.profiles?.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_ID, display_name: 'Nacho' }),
      { onConflict: 'user_id' },
    );
  });

  it('quitar favorito: favoriteTeamId null se guarda sin consultar teams', async () => {
    const client = makeFakeClient({
      profiles: () => ({
        data: { display_name: 'Ignacio', bio: '', favorite_team_id: null },
        error: null,
      }),
    });
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    const profile = await store.saveOwnProfile(USER_ID, {
      displayName: 'Ignacio',
      bio: '',
      favoriteTeamId: null,
    });

    expect(profile.favoriteTeamId).toBeNull();
    expect(client.fromCalls).not.toContain('teams');
    expect(client.builders.profiles?.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ favorite_team_id: null }),
      { onConflict: 'user_id' },
    );
  });

  it('equipo inexistente: rechaza con ProfileValidationError y nunca llega a escribir profiles', async () => {
    const client = makeFakeClient({ teams: () => ({ data: null, error: null }) });
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    await expect(store.saveOwnProfile(USER_ID, VALID_INPUT)).rejects.toThrow(
      ProfileValidationError,
    );
    expect(client.fromCalls).not.toContain('profiles');
  });

  it('rechaza displayName vacío tras trim sin consultar la base', async () => {
    const client = makeFakeClient({});
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    await expect(
      store.saveOwnProfile(USER_ID, { displayName: '   ', bio: '', favoriteTeamId: null }),
    ).rejects.toThrow(ProfileValidationError);
    expect(client.fromCalls).toEqual([]);
  });

  it('rechaza displayName de más de 50 caracteres', async () => {
    const client = makeFakeClient({});
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    await expect(
      store.saveOwnProfile(USER_ID, {
        displayName: 'x'.repeat(51),
        bio: '',
        favoriteTeamId: null,
      }),
    ).rejects.toThrow(ProfileValidationError);
  });

  it('rechaza bio de más de 280 caracteres sin consultar la base', async () => {
    const client = makeFakeClient({});
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    await expect(
      store.saveOwnProfile(USER_ID, {
        displayName: 'Ignacio',
        bio: 'x'.repeat(281),
        favoriteTeamId: null,
      }),
    ).rejects.toThrow(ProfileValidationError);
    expect(client.fromCalls).toEqual([]);
  });

  it('propaga un error de Supabase al upsertear como ProfilePersistenceError', async () => {
    const client = makeFakeClient({
      teams: () => ({ data: { id: TEAM_ID }, error: null }),
      profiles: () => ({ data: null, error: { message: 'constraint violada' } }),
    });
    const store = new SupabaseOwnProfileStore(asSupabaseClient(client));

    await expect(store.saveOwnProfile(USER_ID, VALID_INPUT)).rejects.toThrow(
      ProfilePersistenceError,
    );
  });
});

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
