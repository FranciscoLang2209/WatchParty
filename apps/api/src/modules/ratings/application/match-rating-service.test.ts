import { describe, it, expect, vi } from 'vitest';
import type { Match, MatchStatus } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import type { MatchRatingStore } from '../domain/match-rating-store.js';
import { MatchRatingService } from './match-rating-service.js';

const MATCH_ID = 'a1111111-1111-4111-8111-111111111111';
const USER_ID = 'user-123';

function makeMatch(status: MatchStatus): Match {
  return {
    id: MATCH_ID,
    homeTeam: 'A',
    homeTeamId: 'h',
    awayTeam: 'B',
    awayTeamId: 'a',
    kickoffAt: '2026-10-01T20:00:00Z',
    status,
    score: null,
  };
}

function setup(options: { match?: Match | null; watched?: boolean } = {}) {
  const match = options.match === undefined ? makeMatch('finished') : options.match;
  const catalog: MatchCatalog = { list: vi.fn(), findById: vi.fn(async () => match) };
  const watchedStore: WatchedMatchStore = {
    setWatched: vi.fn(),
    getWatched: vi.fn(async (_u, matchId) => ({ matchId, watched: options.watched ?? true })),
    listHistoryPage: vi.fn(),
  };
  const ratingStore: MatchRatingStore = {
    findRating: vi.fn(async () => 4),
    saveRating: vi.fn(async (_u, _m, rating) => rating),
  };
  return {
    service: new MatchRatingService(catalog, watchedStore, ratingStore),
    watchedStore,
    ratingStore,
  };
}

describe('MatchRatingService.saveOwnRating', () => {
  it('guarda la nota si el partido existe, está finalizado y fue visto', async () => {
    const { service, ratingStore } = setup();

    expect(await service.saveOwnRating(USER_ID, MATCH_ID, 5)).toEqual({ kind: 'ok', rating: 5 });
    expect(ratingStore.saveRating).toHaveBeenCalledWith(USER_ID, MATCH_ID, 5);
  });

  it('partido inexistente: match_not_found y no escribe', async () => {
    const { service, ratingStore } = setup({ match: null });

    expect(await service.saveOwnRating(USER_ID, MATCH_ID, 5)).toEqual({ kind: 'match_not_found' });
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it.each<MatchStatus>(['scheduled', 'live', 'postponed', 'cancelled'])(
    'partido %s: match_not_finished y no escribe',
    async (status) => {
      const { service, ratingStore } = setup({ match: makeMatch(status) });

      expect(await service.saveOwnRating(USER_ID, MATCH_ID, 5)).toEqual({
        kind: 'match_not_finished',
      });
      expect(ratingStore.saveRating).not.toHaveBeenCalled();
    },
  );

  it('partido finalizado pero no visto: match_not_watched y no escribe', async () => {
    const { service, ratingStore, watchedStore } = setup({ watched: false });

    expect(await service.saveOwnRating(USER_ID, MATCH_ID, 5)).toEqual({
      kind: 'match_not_watched',
    });
    expect(watchedStore.getWatched).toHaveBeenCalledWith(USER_ID, MATCH_ID);
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });

  it('un fallo al leer "visto" se propaga y no escribe', async () => {
    const { service, ratingStore, watchedStore } = setup();
    vi.mocked(watchedStore.getWatched).mockRejectedValueOnce(new Error('boom'));

    await expect(service.saveOwnRating(USER_ID, MATCH_ID, 5)).rejects.toThrow('boom');
    expect(ratingStore.saveRating).not.toHaveBeenCalled();
  });
});

describe('MatchRatingService.getOwnRating', () => {
  it('devuelve la nota propia', async () => {
    const { service } = setup();

    expect(await service.getOwnRating(USER_ID, MATCH_ID)).toEqual({ kind: 'ok', rating: 4 });
  });

  it('devuelve rating null sin calificar, aunque el partido no esté finalizado', async () => {
    const { service, ratingStore } = setup({ match: makeMatch('scheduled') });
    vi.mocked(ratingStore.findRating).mockResolvedValueOnce(null);

    expect(await service.getOwnRating(USER_ID, MATCH_ID)).toEqual({ kind: 'ok', rating: null });
  });

  it('partido inexistente: match_not_found', async () => {
    const { service, ratingStore } = setup({ match: null });

    expect(await service.getOwnRating(USER_ID, MATCH_ID)).toEqual({ kind: 'match_not_found' });
    expect(ratingStore.findRating).not.toHaveBeenCalled();
  });
});
