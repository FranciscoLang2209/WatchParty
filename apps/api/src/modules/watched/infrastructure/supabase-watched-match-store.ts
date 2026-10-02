import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { WatchedMatchResult, WatchedMatchStore } from '../domain/watched-match-store.js';
import { WatchedMatchPersistenceError } from './watched-match-persistence-error.js';

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
}
