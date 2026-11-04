import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { MatchRatingStore } from '../../ratings/domain/match-rating-store.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import type { MatchReview, MatchReviewStore } from '../domain/match-review-store.js';

export type GetOwnReviewResult =
  { kind: 'ok'; review: MatchReview | null } | { kind: 'match_not_found' };

export type SaveOwnReviewResult =
  | { kind: 'ok'; review: MatchReview }
  | { kind: 'match_not_found' }
  | { kind: 'match_not_finished' }
  | { kind: 'match_not_watched' }
  | { kind: 'match_not_rated' };

/**
 * Reglas de reseña de un partido (WAT-253, WAT-254). Orquesta puertos ya
 * existentes sin duplicar sus consultas: `MatchCatalog` (existencia y
 * estado), `WatchedMatchStore` (visto por el usuario), `MatchRatingStore`
 * (nota propia, solo lectura) y `MatchReviewStore` (persistencia del texto).
 *
 * Leer la reseña propia solo exige que el partido exista; no depende de su
 * estado ni de si el usuario lo vio, igual que `MatchRatingService.getOwnRating`:
 * así la web puede mostrar una opinión ya guardada aunque después cambie algo.
 *
 * Elegibilidad para GUARDAR/EDITAR: el partido existe, está `finished`, el
 * usuario lo marcó como visto y ya le puso nota. Este servicio nunca escribe
 * en `match_ratings`: la nota, su promedio y sus agregados no cambian.
 *
 * Repetir el mismo texto no reescribe la fila: así `updatedAt` solo cambia
 * cuando el texto cambia de verdad (el trigger de la base lo movería en
 * cualquier UPDATE, aunque el valor fuera idéntico).
 *
 * Los fallos de persistencia se propagan (nunca se convierten en "sin
 * reseña" ni en elegible).
 *
 * Limitación conocida: la elegibilidad se comprueba y después se escribe, sin
 * transacción. Si el usuario deshace "visto" justo entre ambos pasos la
 * reseña igual se guarda; es el mismo nivel de garantía que `MatchRatingService`
 * y no rompe ninguna restricción de la base (la FK solo exige usuario y
 * partido).
 */
export class MatchReviewService {
  constructor(
    private readonly matchCatalog: MatchCatalog,
    private readonly watchedStore: WatchedMatchStore,
    private readonly ratingStore: MatchRatingStore,
    private readonly reviewStore: MatchReviewStore,
  ) {}

  async getOwnReview(userId: string, matchId: string): Promise<GetOwnReviewResult> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return { kind: 'match_not_found' };

    return { kind: 'ok', review: await this.reviewStore.findReview(userId, matchId) };
  }

  /** `body` ya viene normalizado (`normalizeMatchReviewBody`): lo valida el handler. */
  async saveOwnReview(userId: string, matchId: string, body: string): Promise<SaveOwnReviewResult> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return { kind: 'match_not_found' };
    if (match.status !== 'finished') return { kind: 'match_not_finished' };

    const watched = await this.watchedStore.getWatched(userId, matchId);
    if (!watched) return { kind: 'match_not_found' };
    if (!watched.watched) return { kind: 'match_not_watched' };

    if ((await this.ratingStore.findRating(userId, matchId)) === null) {
      return { kind: 'match_not_rated' };
    }

    const existing = await this.reviewStore.findReview(userId, matchId);
    if (existing?.body === body) return { kind: 'ok', review: existing };

    return { kind: 'ok', review: await this.reviewStore.saveReview(userId, matchId, body) };
  }
}
