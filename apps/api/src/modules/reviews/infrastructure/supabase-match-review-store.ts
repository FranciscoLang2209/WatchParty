import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ANONYMOUS_REVIEW_AUTHOR_NAME,
  normalizeMatchReviewBody,
  type ListMatchReviewsOptions,
  type MatchReview,
  type MatchReviewsPage,
  type MatchReviewStore,
} from '../domain/match-review-store.js';
import { isValidReviewsCursor } from '../domain/match-review-cursor.js';
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

  async saveReview(userId: string, matchId: string, body: string): Promise<MatchReview> {
    if (normalizeMatchReviewBody(body) !== body) {
      throw new RangeError(
        'La reseña debe ser un texto de 1 a 500 caracteres, sin espacios exteriores.',
      );
    }

    // ON CONFLICT (user_id, match_id) DO UPDATE: repetir o editar deja una
    // sola fila. created_at no va en el payload, así que se conserva; el
    // trigger de WAT-252 actualiza updated_at en el UPDATE.
    const { data, error } = await this.client
      .from('match_reviews')
      .upsert({ user_id: userId, match_id: matchId, body }, { onConflict: 'user_id,match_id' })
      .select('body, created_at, updated_at')
      .single();

    if (error) {
      throw new MatchReviewPersistenceError(
        `No se pudo guardar la reseña del partido ${matchId}.`,
        error,
      );
    }

    return this.toStoredReview(data, matchId);
  }

  async deleteReview(userId: string, matchId: string): Promise<void> {
    // Filtra por ambas columnas de la PK: nunca borra la reseña de otro usuario
    // ni las de otros partidos. Borrar una fila inexistente no es un error.
    const { error } = await this.client
      .from('match_reviews')
      .delete()
      .eq('user_id', userId)
      .eq('match_id', matchId);

    if (error) {
      throw new MatchReviewPersistenceError(
        `No se pudo eliminar la reseña del partido ${matchId}.`,
        error,
      );
    }
  }

  async listMatchReviews(
    matchId: string,
    { limit, after }: ListMatchReviewsOptions,
  ): Promise<MatchReviewsPage> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('El límite de la página de reseñas debe ser un entero >= 1.');
    }
    if (after && !isValidReviewsCursor(after)) {
      throw new RangeError('El cursor de reseñas es inválido.');
    }

    let query = this.client
      .from('match_reviews')
      .select('user_id, body, created_at')
      .eq('match_id', matchId);

    if (after) {
      // (created_at, user_id) < (after.createdAt, after.userId): anterior en
      // fecha, o misma fecha y user_id menor. El cursor ya está validado.
      query = query.or(
        `created_at.lt.${after.createdAt},and(created_at.eq.${after.createdAt},user_id.lt.${after.userId})`,
      );
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('user_id', { ascending: false })
      .limit(limit + 1);

    if (error) {
      throw new MatchReviewPersistenceError(
        `No se pudo listar las reseñas del partido ${matchId}.`,
        error,
      );
    }

    const rows = (data ?? []).map((row) => this.toListedRow(row, matchId));
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const names = await this.findDisplayNames(pageRows.map((row) => row.userId));

    return {
      items: pageRows.map((row) => ({
        authorName: names.get(row.userId) ?? ANONYMOUS_REVIEW_AUTHOR_NAME,
        body: row.body,
        createdAt: row.createdAt,
      })),
      nextCursor:
        hasMore && lastRow ? { createdAt: lastRow.createdAt, userId: lastRow.userId } : null,
    };
  }

  /**
   * Nombres visibles de `userIds`. Selecciona solo `user_id, display_name`
   * (nunca `*`: `profiles` tiene bio y equipo favorito). Un autor sin perfil,
   * o con el nombre vacío, no aparece en el mapa.
   */
  private async findDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (userIds.length === 0) return names;

    const { data, error } = await this.client
      .from('profiles')
      .select('user_id, display_name')
      .in('user_id', userIds);

    if (error) {
      throw new MatchReviewPersistenceError(
        'No se pudieron leer los nombres de los autores.',
        error,
      );
    }

    for (const row of data ?? []) {
      const { user_id, display_name } = (row ?? {}) as Record<string, unknown>;
      if (typeof user_id !== 'string' || typeof display_name !== 'string') continue;
      const name = display_name.trim();
      if (name.length > 0) names.set(user_id, name);
    }

    return names;
  }

  private toListedRow(row: unknown, matchId: string) {
    const { user_id, body, created_at } = (row ?? {}) as Record<string, unknown>;

    if (typeof user_id !== 'string' || typeof body !== 'string' || typeof created_at !== 'string') {
      throw new MatchReviewPersistenceError(
        `Una reseña persistida del partido ${matchId} es inválida.`,
      );
    }

    return { userId: user_id, body, createdAt: created_at };
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
