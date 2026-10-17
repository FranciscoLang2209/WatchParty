import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import {
  MATCH_SELECT_WITH_TEAMS,
  toMatch,
  type MatchRowWithTeams,
} from '../../matches/infrastructure/supabase-match-store.js';
import {
  isValidWatchedAtCursor,
  type ListWatchedHistoryPageOptions,
  type WatchedHistoryCursor,
  type WatchedHistoryPage,
  type WatchedMatchResult,
  type WatchedMatchStore,
} from '../domain/watched-match-store.js';
import { UUID_PATTERN } from '../http/match-id-pattern.js';
import { WatchedMatchPersistenceError } from './watched-match-persistence-error.js';

// `watched_matches.match_id` es una FK inline sin nombre explícito
// (20260930120000_watched_matches.sql): Postgres la nombra
// `<tabla>_<columna>_fkey`. El hint deja explícito qué relación embeber.
const HISTORY_SELECT = `match_id, created_at, match:matches!watched_matches_match_id_fkey(${MATCH_SELECT_WITH_TEAMS})`;

interface HistoryRow {
  match_id: string;
  created_at: string;
  match: MatchRowWithTeams | null;
}

function assertValidCursor(cursor: WatchedHistoryCursor): void {
  if (!isValidWatchedAtCursor(cursor.watchedAt) || !UUID_PATTERN.test(cursor.matchId)) {
    throw new RangeError('El cursor del historial de vistos es inválido.');
  }
}

/**
 * Implementación de `WatchedMatchStore` respaldada por Supabase (WAT-177),
 * sobre la tabla `watched_matches` de WAT-166 (RLS sin políticas, solo
 * `service_role`).
 *
 * La existencia del partido se comprueba con el `MatchCatalog` persistente
 * de WAT-106, sin duplicar esa consulta — mismo criterio que
 * `SupabasePublicRoomStore.getOrCreatePublicRoom`. El aislamiento entre
 * usuarios no lo da RLS (service_role la salta por completo): lo da que
 * cada operación siempre filtra por `userId`, nunca por un valor que el
 * caller pueda cambiar.
 */
export class SupabaseWatchedMatchStore implements WatchedMatchStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly matchCatalog: MatchCatalog,
  ) {}

  async setWatched(
    userId: string,
    matchId: string,
    watched: boolean,
  ): Promise<WatchedMatchResult | null> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return null;

    if (watched) {
      // ignoreDuplicates: true = ON CONFLICT DO NOTHING sobre la PK
      // compuesta (user_id, match_id): marcar dos veces no duplica la fila
      // ni pisa su created_at original.
      const { error } = await this.client
        .from('watched_matches')
        .upsert(
          { user_id: userId, match_id: matchId },
          { onConflict: 'user_id,match_id', ignoreDuplicates: true },
        );

      if (error) {
        throw new WatchedMatchPersistenceError(
          `No se pudo marcar el partido ${matchId} como visto.`,
          error,
        );
      }
    } else {
      // Borrar una fila que ya no existe no es un error: deshacer dos veces
      // deja el mismo estado final (cero filas), sin romper nada.
      const { error } = await this.client
        .from('watched_matches')
        .delete()
        .eq('user_id', userId)
        .eq('match_id', matchId);

      if (error) {
        throw new WatchedMatchPersistenceError(
          `No se pudo deshacer el partido visto ${matchId}.`,
          error,
        );
      }
    }

    return { matchId, watched };
  }

  async getWatched(userId: string, matchId: string): Promise<WatchedMatchResult | null> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return null;

    // La PK compuesta (user_id, match_id) garantiza a lo sumo una fila.
    const { data, error } = await this.client
      .from('watched_matches')
      .select('match_id')
      .eq('user_id', userId)
      .eq('match_id', matchId)
      .maybeSingle();

    if (error) {
      throw new WatchedMatchPersistenceError(`No se pudo leer el partido visto ${matchId}.`, error);
    }

    return { matchId, watched: data !== null };
  }

  /**
   * Página por cursor sobre `(created_at desc, match_id desc)` (WAT-217),
   * mismo enfoque que `listPageByRoom` de comentarios: pide `limit + 1` filas
   * y la extra solo indica que hay otra página. La comparación con el cursor
   * es estricta (`<`), así que el último visto de la página anterior no se
   * repite. El partido viene embebido (una sola consulta, sin N+1); como la
   * FK no cascadea, todo visto tiene su partido.
   */
  async listHistoryPage(
    userId: string,
    { limit, before }: ListWatchedHistoryPageOptions,
  ): Promise<WatchedHistoryPage> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('El límite de la página debe ser un entero mayor o igual a 1.');
    }
    if (before) assertValidCursor(before);

    let query = this.client.from('watched_matches').select(HISTORY_SELECT).eq('user_id', userId);

    if (before) {
      // (created_at, match_id) < (before.watchedAt, before.matchId), en el
      // filtro `or` de PostgREST: anterior en fecha, o misma fecha y id menor.
      query = query.or(
        `created_at.lt.${before.watchedAt},and(created_at.eq.${before.watchedAt},match_id.lt.${before.matchId})`,
      );
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('match_id', { ascending: false })
      .limit(limit + 1);

    if (error) {
      throw new WatchedMatchPersistenceError('No se pudo listar el historial de vistos.', error);
    }

    const rows = (data ?? []) as unknown as HistoryRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map((row) => {
        if (!row.match) {
          throw new WatchedMatchPersistenceError(
            `El visto del partido ${row.match_id} no pudo resolver su partido.`,
          );
        }
        return { match: toMatch(row.match), watchedAt: new Date(row.created_at).toISOString() };
      }),
      nextCursor:
        hasMore && lastRow ? { watchedAt: lastRow.created_at, matchId: lastRow.match_id } : null,
    };
  }
}
