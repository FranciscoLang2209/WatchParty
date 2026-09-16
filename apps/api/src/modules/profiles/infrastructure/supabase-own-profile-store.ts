import type { SupabaseClient } from '@supabase/supabase-js';
import type { Profile } from '../domain/profile.js';
import type { TeamOption } from '../domain/team-option.js';
import type { OwnProfileStore, SaveOwnProfileInput } from '../domain/own-profile-store.js';
import { ProfilePersistenceError } from './profile-persistence-error.js';

interface ProfileRow {
  display_name: string;
  bio: string;
  favorite_team_id: string | null;
}

function toProfile(row: ProfileRow): Profile {
  return {
    displayName: row.display_name,
    bio: row.bio,
    favoriteTeamId: row.favorite_team_id,
  };
}

/**
 * Implementación de `OwnProfileStore` respaldada por Supabase.
 *
 * WAT-127 implementa las lecturas (`getOwnProfile`, `listTeams`) sobre
 * `profiles`/`teams` — ambas ya migradas y con RLS/privilegios exclusivos
 * de `service_role` (WAT-123/124/125). `saveOwnProfile` es WAT-128: acá
 * queda como stub para que la clase cumpla `OwnProfileStore` completo.
 */
export class SupabaseOwnProfileStore implements OwnProfileStore {
  constructor(private readonly client: SupabaseClient) {}

  /**
   * `userId` viene siempre del usuario autenticado, así que la ausencia de
   * fila es el único caso "vacío": devuelve `null`, no lanza. Solo
   * selecciona las tres columnas públicas de `Profile` — nunca `user_id`,
   * timestamps ni `*`.
   */
  async getOwnProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select('display_name, bio, favorite_team_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new ProfilePersistenceError(`No se pudo obtener el perfil de ${userId}.`, error);
    }

    if (!data) return null;

    return toProfile(data as ProfileRow);
  }

  /**
   * Proyección mínima de `teams`, nunca derivada de `matches`: siempre
   * consulta el catálogo persistido por WAT-106. Orden determinista por
   * nombre y, ante empate, por `id` — sin el desempate, Postgres no
   * garantiza un orden estable entre corridas para nombres iguales.
   */
  async listTeams(): Promise<TeamOption[]> {
    const { data, error } = await this.client
      .from('teams')
      .select('id, name')
      .order('name', { ascending: true })
      .order('id', { ascending: true });

    if (error) {
      throw new ProfilePersistenceError('No se pudo listar los equipos.', error);
    }

    return (data ?? []) as TeamOption[];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- firma completa de OwnProfileStore; implementación real en WAT-128
  async saveOwnProfile(userId: string, input: SaveOwnProfileInput): Promise<Profile> {
    throw new Error('saveOwnProfile todavía no está implementado (WAT-128).');
  }
}
