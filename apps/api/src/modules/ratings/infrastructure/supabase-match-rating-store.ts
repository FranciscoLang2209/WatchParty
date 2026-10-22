import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isValidMatchRating,
  MATCH_RATING_MAX,
  MATCH_RATING_MIN,
  type MatchRatingStore,
  type MatchRatingSummary,
} from '../domain/match-rating-store.js';
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

  /**
   * Llama a la función SQL `match_rating_summary` (WAT-214): la base cuenta y
   * promedia, y acá solo llegan dos números, nunca las notas de otros
   * usuarios. PostgREST devuelve un arreglo con exactamente una fila.
   */
  async getSummary(matchId: string): Promise<MatchRatingSummary> {
    const { data, error } = await this.client.rpc('match_rating_summary', {
      p_match_id: matchId,
    });

    if (error) {
      throw new MatchRatingPersistenceError(
        `No se pudo leer el resumen de calificaciones del partido ${matchId}.`,
        error,
      );
    }

    return this.toStoredSummary(data, matchId);
  }

  /**
   * Valida la fila de la base en vez de confiar en ella: un resumen
   * incoherente (cuenta negativa, promedio fuera de 1–5, promedio con 0 votos
   * o sin promedio con votos) se trata como fallo de persistencia, no se
   * devuelve como dato.
   */
  private toStoredSummary(data: unknown, matchId: string): MatchRatingSummary {
    const row: unknown = Array.isArray(data) && data.length === 1 ? data[0] : null;
    const count = isRecord(row) ? row.rating_count : undefined;
    const average = isRecord(row) ? row.rating_average : undefined;

    const countIsValid = typeof count === 'number' && Number.isInteger(count) && count >= 0;
    const averageIsValid =
      count === 0
        ? average === null
        : typeof average === 'number' &&
          Number.isFinite(average) &&
          average >= MATCH_RATING_MIN &&
          average <= MATCH_RATING_MAX;

    if (!countIsValid || !averageIsValid) {
      throw new MatchRatingPersistenceError(
        `El resumen de calificaciones del partido ${matchId} es inválido.`,
      );
    }

    return { average: count === 0 ? null : (average as number), count };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
