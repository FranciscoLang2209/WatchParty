import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchesRouter } from './matches-router.js';
import { SEARCH_TEXT_MAX_LENGTH } from './search-matches-handler.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import {
  InvalidSearchCursorError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type MatchSearch,
  type SearchPage,
} from '../domain/match-search.js';
import type { Match } from '../domain/match.js';
import type { MatchCatalog } from '../domain/match-catalog.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: { id: 'user-123', email: 'persona@example.com' } },
    error: null,
  } as GetUserResult);
}

const MATCH: Match = {
  id: 'aaa',
  homeTeam: 'River Plate',
  homeTeamId: 'team-river-plate',
  awayTeam: 'Boca Juniors',
  awayTeamId: 'team-boca-juniors',
  kickoffAt: '2024-05-01T21:00:00.000Z',
  status: 'finished',
  score: { home: 2, away: 1 },
};

const catalog: MatchCatalog = { list: vi.fn(), findById: vi.fn() };

function buildSearch(page: SearchPage = { kind: 'matches', items: [MATCH], nextCursor: 'next' }) {
  const search = vi.fn<MatchSearch['search']>(async () => page);
  return { search };
}

function buildTestApp(matchSearch: MatchSearch) {
  const app = express();

  app.use('/matches', createMatchesRouter(catalog, undefined, matchSearch));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function get(app: express.Express, url: string) {
  mockAuthenticated();
  return request(app).get(url).set('Authorization', 'Bearer good-token');
}

describe('GET /matches/search', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
    vi.mocked(catalog.findById).mockReset();
  });

  it('exige sesión', async () => {
    const { search } = buildSearch();
    const response = await request(buildTestApp({ search })).get('/matches/search?q=river');

    expect(response.status).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it('busca partidos con el texto recortado y responde la página con su cursor', async () => {
    const { search } = buildSearch();

    const response = await get(buildTestApp({ search }), '/matches/search?q=%20River%20');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matches: [MATCH], nextCursor: 'next' });
    expect(search).toHaveBeenCalledWith({
      query: 'River',
      kind: 'matches',
      limit: SEARCH_DEFAULT_LIMIT,
      cursor: null,
    });
  });

  it('sin coincidencias responde 200 con una lista vacía', async () => {
    const { search } = buildSearch({ kind: 'matches', items: [], nextCursor: null });

    const response = await get(buildTestApp({ search }), '/matches/search?q=zzz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matches: [], nextCursor: null });
  });

  it('pasa limit y cursor tal cual a la búsqueda', async () => {
    const { search } = buildSearch();

    await get(buildTestApp({ search }), '/matches/search?q=river&limit=5&cursor=abc');

    expect(search).toHaveBeenCalledWith({
      query: 'river',
      kind: 'matches',
      limit: 5,
      cursor: 'abc',
    });
  });

  it('el texto con caracteres especiales llega intacto: es entrada, no patrón', async () => {
    const { search } = buildSearch();

    await get(
      buildTestApp({ search }),
      `/matches/search?q=${encodeURIComponent('100%_a\\"b,(c)')}`,
    );

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: '100%_a\\"b,(c)' }));
  });

  it('no se confunde con el detalle de un partido', async () => {
    const { search } = buildSearch();

    await get(buildTestApp({ search }), '/matches/search?q=river');

    expect(catalog.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['sin q', '/matches/search'],
    ['q vacío', '/matches/search?q='],
    ['q sólo espacios', '/matches/search?q=%20%20'],
    ['q repetido', '/matches/search?q=a&q=b'],
    ['q como objeto', '/matches/search?q[a]=b'],
    ['q demasiado largo', `/matches/search?q=${'a'.repeat(SEARCH_TEXT_MAX_LENGTH + 1)}`],
    ['limit no numérico', '/matches/search?q=a&limit=abc'],
    ['limit decimal', '/matches/search?q=a&limit=1.5'],
    ['limit negativo', '/matches/search?q=a&limit=-1'],
    ['limit cero', '/matches/search?q=a&limit=0'],
    ['limit sobre el máximo', `/matches/search?q=a&limit=${SEARCH_MAX_LIMIT + 1}`],
    ['limit repetido', '/matches/search?q=a&limit=1&limit=2'],
    ['cursor vacío', '/matches/search?q=a&cursor='],
    ['cursor repetido', '/matches/search?q=a&cursor=x&cursor=y'],
    ['cursor demasiado largo', `/matches/search?q=a&cursor=${'x'.repeat(513)}`],
  ])('rechaza con 400 VALIDATION_ERROR: %s', async (_caso, url) => {
    const { search } = buildSearch();

    const response = await get(buildTestApp({ search }), url);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(search).not.toHaveBeenCalled();
  });

  it('un cursor alterado que rechaza la búsqueda responde 400, no 500', async () => {
    const search = vi.fn<MatchSearch['search']>(async () => {
      throw new InvalidSearchCursorError();
    });

    const response = await get(buildTestApp({ search }), '/matches/search?q=river&cursor=zzz');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('un fallo de persistencia responde 500 sin filtrar el error crudo', async () => {
    const search = vi.fn<MatchSearch['search']>(async () => {
      throw new Error('boom interno');
    });

    const response = await get(buildTestApp({ search }), '/matches/search?q=river');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('boom interno');
  });
});
