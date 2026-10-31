import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchReview, MatchReviewStore } from '../domain/match-review-store.js';
import { MatchReviewPersistenceError } from './match-review-persistence-error.js';

/**
 * `MatchReviewStore` respaldado por Supabase sobre `match_reviews` (WAT-252:
 * RLS sin políticas, solo `service_role`). Como `service_role` salta RLS, el
 * aislamiento entre usuarios lo da que toda lectura filtra con el `userId`
 * recibido, nunca con un valor que el cliente controle.
 */
export class SupabaseMatchReviewStore implements MatchReviewStore {
  constructor(private readonly client: SupabaseClient) {}

  async findReview(userId: string, matchId: string): Promise<MatchReview | null> {
    const { data, error } = await this.client
      .from('match_reviews')
      .select('body, created_at, updated_at')
      .eq('user_id', userId)
      .eq('match_id', matchId)
      .maybeSingle();

    if (error) {
      throw new MatchReviewPersistenceError(
        `No se pudo leer la reseña del partido ${matchId}.`,
        error,
      );
    }

    return data === null ? null : this.toStoredReview(data, matchId);
  }

  /** La base ya lo garantiza con NOT NULL; esto evita devolver basura si algo cambiara. */
  private toStoredReview(row: unknown, matchId: string): MatchReview {
    const { body, created_at, updated_at } = (row ?? {}) as Record<string, unknown>;

    if (
      typeof body !== 'string' ||
      typeof created_at !== 'string' ||
      typeof updated_at !== 'string'
    ) {
      throw new MatchReviewPersistenceError(
        `La reseña persistida del partido ${matchId} es inválida.`,
      );
    }

    return { body, createdAt: created_at, updatedAt: updated_at };
  }
}
