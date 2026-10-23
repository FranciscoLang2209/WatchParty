import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserStatistics, UserStatisticsStore } from '../domain/user-statistics-store.js';
import { UserStatisticsPersistenceError } from './user-statistics-persistence-error.js';

/** Qué tabla y qué columna de usuario respaldan cada total. */
const SOURCES = {
  watchedMatches: { table: 'watched_matches', userColumn: 'user_id', label: 'partidos vistos' },
  ratings: { table: 'match_ratings', userColumn: 'user_id', label: 'calificaciones' },
  comments: { table: 'room_comments', userColumn: 'author_id', label: 'comentarios' },
} as const satisfies Record<
  keyof UserStatistics,
  { table: string; userColumn: string; label: string }
>;

/**
 * Implementación de `UserStatisticsStore` respaldada por Supabase (WAT-231),
 * sobre `watched_matches` (WAT-166), `match_ratings` (WAT-211) y
 * `room_comments`: tablas con RLS sin políticas, solo `service_role`.
 *
 * Cada total es un `count` exacto con `head: true`: Postgres cuenta todas las
 * filas del usuario sin traerlas, así que no depende de la paginación del
 * historial. `match_ratings` tiene una fila por (usuario, partido), y editar
 * una nota la actualiza en lugar de insertar otra: el total no crece.
 *
 * El aislamiento lo da filtrar siempre por `userId`, igual que el resto de
 * los stores (service_role salta RLS).
 */
export class SupabaseUserStatisticsStore implements UserStatisticsStore {
  constructor(private readonly client: SupabaseClient) {}

  async getUserStatistics(userId: string): Promise<UserStatistics> {
    const [watchedMatches, ratings, comments] = await Promise.all([
      this.count(userId, SOURCES.watchedMatches),
      this.count(userId, SOURCES.ratings),
      this.count(userId, SOURCES.comments),
    ]);

    return { watchedMatches, ratings, comments };
  }

  private async count(
    userId: string,
    source: (typeof SOURCES)[keyof UserStatistics],
  ): Promise<number> {
    const { count, error } = await this.client
      .from(source.table)
      .select('*', { count: 'exact', head: true })
      .eq(source.userColumn, userId);

    // Sin error pero sin conteo tampoco es cero: es una respuesta que no se
    // puede interpretar, y se trata como fallo.
    if (error || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new UserStatisticsPersistenceError(
        `No se pudo contar los ${source.label} del usuario.`,
        error ?? undefined,
      );
    }

    return count;
  }
}
