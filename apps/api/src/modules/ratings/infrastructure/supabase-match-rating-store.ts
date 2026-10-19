import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidMatchRating, type MatchRatingStore } from '../domain/match-rating-store.js';
import { MatchRatingPersistenceError } from './match-rating-persistence-error.js';

/**
 * `MatchRatingStore` respaldado por Supabase sobre `match_ratings` (WAT-211:
 * RLS sin políticas, solo `service_role`). Como `service_role` salta RLS, el
 * aislamiento entre usuarios lo da que toda operación filtra o escribe con el
 * `userId` recibido, nunca con un valor que el cliente controle.
 */
export class SupabaseMatchRatingStore implements MatchRatingStore {
  constructor(private readonly client: SupabaseClient) {}

  async findRating(userId: string, matchId: string): Promise<number | null> {
    const { data, error } = await this.client
      .from('match_ratings')
      .select('rating')
      .eq('user_id', userId)
      .eq('match_id', matchId)
      .maybeSingle();

    if (error) {
      throw new MatchRatingPersistenceError(
        `No se pudo leer la calificación del partido ${matchId}.`,
        error,
      );
    }

    return data === null ? null : this.toStoredRating(data.rating, matchId);
  }

  async saveRating(userId: string, matchId: string, rating: number): Promise<number> {
    if (!isValidMatchRating(rating)) {
      throw new RangeError('La calificación debe ser un entero entre 1 y 5.');
    }

    // ON CONFLICT (user_id, match_id) DO UPDATE: repetir o editar deja una
    // sola fila. created_at no va en el payload, así que se conserva; el
    // trigger de WAT-211 actualiza updated_at en el UPDATE.
    const { data, error } = await this.client
      .from('match_ratings')
      .upsert({ user_id: userId, match_id: matchId, rating }, { onConflict: 'user_id,match_id' })
      .select('rating')
      .single();

    if (error) {
      throw new MatchRatingPersistenceError(
        `No se pudo guardar la calificación del partido ${matchId}.`,
        error,
      );
    }

    return this.toStoredRating(data.rating, matchId);
  }

  /** La base ya lo garantiza con CHECK; esto evita devolver basura si algo cambiara. */
  private toStoredRating(value: unknown, matchId: string): number {
    if (!isValidMatchRating(value)) {
      throw new MatchRatingPersistenceError(
        `La calificación persistida del partido ${matchId} es inválida.`,
      );
    }
    return value;
  }
}
