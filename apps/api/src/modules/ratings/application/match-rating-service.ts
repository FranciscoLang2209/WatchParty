import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import type { MatchRatingStore, MatchRatingSummary } from '../domain/match-rating-store.js';

export type GetOwnRatingResult =
  { kind: 'ok'; rating: number | null } | { kind: 'match_not_found' };

export type GetRatingSummaryResult =
  { kind: 'ok'; summary: MatchRatingSummary } | { kind: 'match_not_found' };

export type SaveOwnRatingResult =
  | { kind: 'ok'; rating: number }
  | { kind: 'match_not_found' }
  | { kind: 'match_not_finished' }
  | { kind: 'match_not_watched' };

/**
 * Reglas de calificación de un partido (WAT-212). Orquesta tres puertos ya
 * existentes sin duplicar sus consultas: `MatchCatalog` (existencia y
 * estado), `WatchedMatchStore` (visto por el usuario) y `MatchRatingStore`
 * (persistencia de la nota).
 *
 * Resumen (WAT-214): promedio y cantidad de votos de un partido. Solo exige
 * que el partido exista; no depende de su estado ni de si quien consulta lo
 * calificó o lo vio.
 *
 * Elegibilidad para GUARDAR/EDITAR: el partido existe, está `finished` y el
 * usuario lo marcó como visto. Leer la nota propia solo exige que el partido
 * exista: así la web puede mostrar una nota ya guardada aunque después
 * cambie algo.
 *
 * Los fallos de persistencia se propagan (nunca se convierten en "sin nota"
 * ni en elegible).
 *
 * Limitación conocida: la elegibilidad se comprueba y después se escribe, sin
 * transacción. Si el usuario deshace "visto" justo entre ambos pasos la nota
 * igual se guarda; es el mismo nivel de garantía que el resto del MVP y no
 * rompe ninguna restricción de la base (la FK solo exige usuario y partido).
 */
export class MatchRatingService {
  constructor(
    private readonly matchCatalog: MatchCatalog,
    private readonly watchedStore: WatchedMatchStore,
    private readonly ratingStore: MatchRatingStore,
  ) {}

  async getOwnRating(userId: string, matchId: string): Promise<GetOwnRatingResult> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return { kind: 'match_not_found' };

    return { kind: 'ok', rating: await this.ratingStore.findRating(userId, matchId) };
  }

  async getRatingSummary(matchId: string): Promise<GetRatingSummaryResult> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return { kind: 'match_not_found' };

    return { kind: 'ok', summary: await this.ratingStore.getSummary(matchId) };
  }

  async saveOwnRating(
    userId: string,
    matchId: string,
    rating: number,
  ): Promise<SaveOwnRatingResult> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return { kind: 'match_not_found' };
    if (match.status !== 'finished') return { kind: 'match_not_finished' };

    const watched = await this.watchedStore.getWatched(userId, matchId);
    if (!watched) return { kind: 'match_not_found' };
    if (!watched.watched) return { kind: 'match_not_watched' };

    return { kind: 'ok', rating: await this.ratingStore.saveRating(userId, matchId, rating) };
  }
}
