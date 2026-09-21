import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { PublicRoom } from '../domain/public-room.js';
import type { PublicRoomStore } from '../domain/public-room-store.js';
import { RoomPersistenceError } from './room-persistence-error.js';

const ROOM_SELECT = 'id, match_id, created_at';

// Código de error de Postgres para unique_violation: es el que devuelve la
// inserción cuando choca con `rooms_match_id_key` (migración de WAT-160).
// Referencia: https://www.postgresql.org/docs/current/errcodes-appendix.html
const POSTGRES_UNIQUE_VIOLATION = '23505';

interface RoomRow {
  id: string;
  match_id: string;
  created_at: string;
}

function toPublicRoom(row: RoomRow): PublicRoom {
  return {
    id: row.id,
    matchId: row.match_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Implementación de `PublicRoomStore` respaldada por Supabase (WAT-146),
 * sobre la tabla `rooms` de WAT-160 (RLS sin políticas, solo `service_role`).
 *
 * Recibe el `SupabaseClient` por constructor, igual que
 * `SupabaseOwnProfileStore`: quien lo componga debe reutilizar
 * `createSupabaseSportsDataClient`. La existencia del partido se comprueba
 * con el `MatchCatalog` persistente de WAT-106, sin duplicar esa consulta.
 */
export class SupabasePublicRoomStore implements PublicRoomStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly matchCatalog: MatchCatalog,
  ) {}

  /**
   * Lee la sala del partido y, si no existe, la inserta. Si la inserción
   * choca con la unicidad de `match_id` es porque otro pedido la creó entre
   * la lectura y la inserción: se vuelve a leer una única vez y se devuelve
   * esa sala. No hay reintentos en bucle.
   */
  async getOrCreatePublicRoom(matchId: string): Promise<PublicRoom | null> {
    const match = await this.matchCatalog.findById(matchId);
    if (!match) return null;

    const existing = await this.findByMatchId(matchId);
    if (existing) return existing;

    const { data, error } = await this.client
      .from('rooms')
      .insert({ match_id: matchId })
      .select(ROOM_SELECT)
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        const created = await this.findByMatchId(matchId);
        if (created) return created;
      }

      throw new RoomPersistenceError(`No se pudo crear la sala del partido ${matchId}.`, error);
    }

    return toPublicRoom(data as RoomRow);
  }

  async findPublicRoomById(roomId: string): Promise<PublicRoom | null> {
    const { data, error } = await this.client
      .from('rooms')
      .select(ROOM_SELECT)
      .eq('id', roomId)
      .maybeSingle();

    if (error) {
      throw new RoomPersistenceError(`No se pudo obtener la sala ${roomId}.`, error);
    }

    if (!data) return null;

    return toPublicRoom(data as RoomRow);
  }

  private async findByMatchId(matchId: string): Promise<PublicRoom | null> {
    const { data, error } = await this.client
      .from('rooms')
      .select(ROOM_SELECT)
      .eq('match_id', matchId)
      .maybeSingle();

    if (error) {
      throw new RoomPersistenceError(`No se pudo obtener la sala del partido ${matchId}.`, error);
    }

    if (!data) return null;

    return toPublicRoom(data as RoomRow);
  }
}
