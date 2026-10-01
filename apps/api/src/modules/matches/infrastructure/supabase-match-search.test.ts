import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseMatchSearch, TEAM_LOOKUP_BATCH_SIZE } from './supabase-match-search.js';
import { SEARCH_MAX_LIMIT } from '../domain/match-search.js';

type FakeResult = { data: unknown; error: { message: string; code?: string } | null };

/** Mismo doble de PostgrestFilterBuilder que usa supabase-match-store.test.ts, con más métodos encadenables. */
function makeQueryBuilder(result: FakeResult) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder = {
    select: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'select', args });
      return builder;
    }),
    ilike: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'ilike', args });
      return builder;
    }),
    order: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'order', args });
      return builder;
    }),
    or: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'or', args });
      return builder;
    }),
    limit: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'limit', args });
      return builder;
    }),
    gt: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'gt', args });
      return builder;
    }),
    then: (resolve: (value: FakeResult) => unknown) => resolve(result),
    calls,
  };
  return builder;
}

interface FakeClientHandlers {
  teams?: (() => FakeResult)[];
  matches?: (() => FakeResult)[];
}

function makeFakeClient(handlers: FakeClientHandlers) {
  const teamsQueue = [...(handlers.teams ?? [])];
  const matchesQueue = [...(handlers.matches ?? [])];
  const fromCalls: string[] = [];
  const builders: {
    teams: ReturnType<typeof makeQueryBuilder>[];
    matches: ReturnType<typeof makeQueryBuilder>[];
  } = { teams: [], matches: [] };

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    if (table === 'teams') {
      const result = teamsQueue.shift()?.() ?? { data: [], error: null };
      const builder = makeQueryBuilder(result);
      builders.teams.push(builder);
      return builder;
    }
    if (table === 'matches') {
      const result = matchesQueue.shift()?.() ?? { data: [], error: null };
      const builder = makeQueryBuilder(result);
      builders.matches.push(builder);
      return builder;
    }
    throw new Error(`Tabla inesperada en el fake client: ${table}`);
  });

  return { from, fromCalls, builders };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

function nthBuilder(
  builders: ReturnType<typeof makeQueryBuilder>[],
  index: number,
): ReturnType<typeof makeQueryBuilder> {
  const builder = builders[index];
  if (!builder) throw new Error(`No se registró ninguna consulta en la posición ${index}.`);
  return builder;
}

const RIVER = { id: 'a1111111-1111-1111-1111-111111111111', name: 'River Plate' };
const RACING = { id: 'a2222222-2222-2222-2222-222222222222', name: 'Racing Club' };
const BOCA = { id: 'a3333333-3333-3333-3333-333333333333', name: 'Boca Juniors' };

const MATCH_ROW = {
  id: 'b1111111-1111-1111-1111-111111111111',
  kickoff_at: '2026-09-06T21:00:00+00:00',
  status: 'scheduled',
  home_team: { name: 'River Plate' },
  away_team: { name: 'Boca Juniors' },
};

describe('SupabaseMatchSearch', () => {
  describe('kind: teams', () => {
    it('busca equipos case-insensitive y respeta el límite pidiendo una fila de más', async () => {
      const client = makeFakeClient({ teams: [() => ({ data: [RIVER], error: null })] });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const page = await search.search({ query: 'river', kind: 'teams', limit: 5 });

      expect(page).toEqual({ kind: 'teams', items: [RIVER], nextCursor: null });
      const builder = nthBuilder(client.builders.teams, 0);
      expect(builder.ilike).toHaveBeenCalledWith('name', '%river%');
      expect(builder.limit).toHaveBeenCalledWith(6);
      expect(builder.order).toHaveBeenNthCalledWith(1, 'name', { ascending: true });
      expect(builder.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('con más filas que el límite arma un nextCursor y devuelve solo el límite pedido', async () => {
      const client = makeFakeClient({
        teams: [() => ({ data: [RIVER, RACING], error: null })],
      });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const page = await search.search({ query: '', kind: 'teams', limit: 1 });

      expect(page.items).toEqual([RIVER]);
      expect(page.nextCursor).not.toBeNull();
    });

    it('reutiliza el cursor de la página anterior para pedir la siguiente sin repetir', async () => {
      const client = makeFakeClient({
        teams: [
          () => ({ data: [RIVER, RACING], error: null }),
          () => ({ data: [BOCA], error: null }),
        ],
      });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const first = await search.search({ query: '', kind: 'teams', limit: 1 });
      const second = await search.search({
        query: '',
        kind: 'teams',
        limit: 1,
        cursor: first.nextCursor,
      });

      expect(second.items.map((team) => team.id)).not.toContain(RIVER.id);
      const secondBuilder = nthBuilder(client.builders.teams, 1);
      expect(secondBuilder.or).toHaveBeenCalledWith(
        `name.gt.${RIVER.name},and(name.eq.${RIVER.name},id.gt.${RIVER.id})`,
      );
    });

    it('un texto sin coincidencias devuelve una página vacía sin error', async () => {
      const client = makeFakeClient({ teams: [() => ({ data: [], error: null })] });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const page = await search.search({ query: 'inexistente', kind: 'teams', limit: 10 });

      expect(page).toEqual({ kind: 'teams', items: [], nextCursor: null });
    });

    it('un límite fuera de rango se ajusta al máximo del módulo', async () => {
      const client = makeFakeClient({ teams: [() => ({ data: [], error: null })] });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      await search.search({ query: '', kind: 'teams', limit: 9999 });

      expect(nthBuilder(client.builders.teams, 0).limit).toHaveBeenCalledWith(SEARCH_MAX_LIMIT + 1);
    });

    it('un nombre de equipo con comillas y coma se escapa con barra invertida (PostgREST, no SQL)', async () => {
      const TRICKY = { id: 'c1111111-1111-1111-1111-111111111111', name: 'Club "A", B' };
      const client = makeFakeClient({
        teams: [() => ({ data: [TRICKY, RACING], error: null }), () => ({ data: [], error: null })],
      });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const first = await search.search({ query: '', kind: 'teams', limit: 1 });
      await search.search({ query: '', kind: 'teams', limit: 1, cursor: first.nextCursor });

      const expectedValue = '"Club \\"A\\", B"';
      expect(nthBuilder(client.builders.teams, 1).or).toHaveBeenCalledWith(
        `name.gt.${expectedValue},and(name.eq.${expectedValue},id.gt.${TRICKY.id})`,
      );
    });
  });

  describe('kind: matches', () => {
    it('busca partidos donde el texto coincide con el equipo local o visitante', async () => {
      const client = makeFakeClient({
        teams: [() => ({ data: [RIVER], error: null })],
        matches: [() => ({ data: [MATCH_ROW], error: null })],
      });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const page = await search.search({ query: 'river', kind: 'matches', limit: 5 });

      expect(page.kind).toBe('matches');
      expect(page.items).toEqual([
        {
          id: MATCH_ROW.id,
          homeTeam: 'River Plate',
          awayTeam: 'Boca Juniors',
          kickoffAt: '2026-09-06T21:00:00.000Z',
          status: 'scheduled',
        },
      ]);
      expect(nthBuilder(client.builders.matches, 0).or).toHaveBeenCalledWith(
        `home_team_id.in.(${RIVER.id}),away_team_id.in.(${RIVER.id})`,
      );
    });

    it('un texto que no coincide con ningún equipo devuelve página vacía sin tocar matches', async () => {
      const client = makeFakeClient({ teams: [() => ({ data: [], error: null })] });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const page = await search.search({ query: 'inexistente', kind: 'matches', limit: 5 });

      expect(page).toEqual({ kind: 'matches', items: [], nextCursor: null });
      expect(client.fromCalls).not.toContain('matches');
    });

    it('kind=matches y kind=teams no mezclan resultados', async () => {
      const client = makeFakeClient({
        matches: [() => ({ data: [MATCH_ROW], error: null })],
      });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      const page = await search.search({ query: '', kind: 'matches', limit: 5 });

      expect(page.kind).toBe('matches');
      expect((page.items[0] as { homeTeam?: string }).homeTeam).toBe('River Plate');
    });

    it('no trunca equipos coincidentes aunque haya más de una página, y arma los partidos con todos', async () => {
      const KNOWN_FIRST_TEAM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000000';
      const extraTeamId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const firstBatch = Array.from({ length: TEAM_LOOKUP_BATCH_SIZE }, (_, index) => ({
        id:
          index === 0
            ? KNOWN_FIRST_TEAM_ID
            : `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, '0')}`,
      }));

      const client = makeFakeClient({
        teams: [
          () => ({ data: firstBatch, error: null }),
          () => ({ data: [{ id: extraTeamId }], error: null }),
        ],
        matches: [() => ({ data: [MATCH_ROW], error: null })],
      });
      const search = new SupabaseMatchSearch(asSupabaseClient(client));

      await search.search({ query: 'club', kind: 'matches', limit: 5 });

      expect(client.builders.teams).toHaveLength(2);
      expect(nthBuilder(client.builders.matches, 0).or).toHaveBeenCalledWith(
        expect.stringContaining(extraTeamId),
      );
      expect(nthBuilder(client.builders.matches, 0).or).toHaveBeenCalledWith(
        expect.stringContaining(KNOWN_FIRST_TEAM_ID),
      );
    });
  });

  describe('cursor inválido', () => {
    it('un cursor sin separador interno se rechaza', async () => {
      const client = makeFakeClient({});
      const search = new SupabaseMatchSearch(asSupabaseClient(client));
      const brokenCursor = Buffer.from('sin-separador-interno', 'utf8').toString('base64url');

      await expect(
        search.search({ query: '', kind: 'teams', limit: 1, cursor: brokenCursor }),
      ).rejects.toThrow('Cursor de búsqueda inválido.');
    });

    it('un cursor cuyo id no tiene forma de uuid se rechaza', async () => {
      const client = makeFakeClient({});
      const search = new SupabaseMatchSearch(asSupabaseClient(client));
      const brokenCursor = Buffer.from('River Plate\u0000no-es-un-uuid', 'utf8').toString(
        'base64url',
      );

      await expect(
        search.search({ query: '', kind: 'teams', limit: 1, cursor: brokenCursor }),
      ).rejects.toThrow('Cursor de búsqueda inválido.');
    });
  });
});
