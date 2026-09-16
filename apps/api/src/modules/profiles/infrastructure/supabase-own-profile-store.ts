import type { SupabaseClient } from '@supabase/supabase-js';
import type { Profile } from '../domain/profile.js';
import type { TeamOption } from '../domain/team-option.js';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  type OwnProfileStore,
  type SaveOwnProfileInput,
} from '../domain/own-profile-store.js';
import { ProfileValidationError } from '../domain/profile-validation-error.js';
import { ProfilePersistenceError } from './profile-persistence-error.js';

// Código de error de Postgres para "el valor no tiene la forma del tipo de
// dato esperado" (invalid_text_representation) — mismo criterio que
// SupabaseMatchStore (WAT-106): un favoriteTeamId que ni siquiera es un
// UUID válido se trata como "no existe", no como fallo de persistencia.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02';

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

  /**
   * Upsert por `user_id` (PK de `profiles`): una fila por usuario, alta o
   * edición según exista o no. Valida en código antes de tocar la base
   * (`ProfileValidationError`, para que un handler HTTP futuro devuelva
   * 400) y deja las constraints de `20260912160809_profiles_constraints.sql`
   * como defensa final, no como única defensa.
   */
  async saveOwnProfile(userId: string, input: SaveOwnProfileInput): Promise<Profile> {
    const displayName = input.displayName.trim();

    if (
      displayName.length < DISPLAY_NAME_MIN_LENGTH ||
      displayName.length > DISPLAY_NAME_MAX_LENGTH
    ) {
      throw new ProfileValidationError(
        'display_name_length',
        `El nombre visible debe tener entre ${DISPLAY_NAME_MIN_LENGTH} y ${DISPLAY_NAME_MAX_LENGTH} caracteres.`,
      );
    }

    if (input.bio.length > BIO_MAX_LENGTH) {
      throw new ProfileValidationError(
        'bio_length',
        `La biografía no puede superar los ${BIO_MAX_LENGTH} caracteres.`,
      );
    }

    if (input.favoriteTeamId !== null && !(await this.teamExists(input.favoriteTeamId))) {
      throw new ProfileValidationError(
        'favorite_team_not_found',
        `El equipo ${input.favoriteTeamId} no existe.`,
      );
    }

    const { data, error } = await this.client
      .from('profiles')
      .upsert(
        {
          user_id: userId,
          display_name: displayName,
          bio: input.bio,
          favorite_team_id: input.favoriteTeamId,
        },
        { onConflict: 'user_id' },
      )
      .select('display_name, bio, favorite_team_id')
      .single();

    if (error) {
      throw new ProfilePersistenceError(`No se pudo guardar el perfil de ${userId}.`, error);
    }

    return toProfile(data as ProfileRow);
  }

  private async teamExists(teamId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('teams')
      .select('id')
      .eq('id', teamId)
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_INVALID_TEXT_REPRESENTATION) return false;
      throw new ProfilePersistenceError(`No se pudo verificar el equipo ${teamId}.`, error);
    }

    return data !== null;
  }
}
