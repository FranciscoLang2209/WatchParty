import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { MatchReview, MatchReviewStore } from '../domain/match-review-store.js';

export type GetOwnReviewResult =
  { kind: 'ok'; review: MatchReview | null } | { kind: 'match_not_found' };

/**
 * Reglas de reseña de un partido (WAT-253). Leer la reseña propia solo exige
 * que el partido exista; no depende de su estado ni de si el usuario lo vio,
 * igual que `MatchRatingService.getOwnRating`: así la web puede mostrar una
 * opinión ya guardada aunque después cambie algo.
 *
 * Los fallos de persistencia se propagan (nunca se convierten en "sin
 * reseña").
 */
export class MatchReviewService {
  constructor(
    private readonly matchCatalog: MatchCatalog,
    private readonly reviewStore: MatchReviewStore,
  ) {}

  async getOwnReview(userId: string, matchId: string): Promise<GetOwnReviewResult> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return { kind: 'match_not_found' };

    return { kind: 'ok', review: await this.reviewStore.findReview(userId, matchId) };
  }
}
