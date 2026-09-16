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

// Formato canónico de UUID (el mismo que genera gen_random_uuid() en
// Postgres). Se valida en código, antes de consultar Supabase, para que un
// favoriteTeamId con formato inválido rechace sin tocar la base — WAT-128
// pide justamente esto en vez de depender únicamente del código de error
// 22P02 que devolvería Postgres.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Implementación de `OwnProfileStore` respaldada por Supabase (WAT-127
 * lecturas, WAT-128 escritura), sobre las tablas `profiles` y `teams` —
 * ambas ya migradas y con RLS/privilegios exclusivos de `service_role`
 * (WAT-123/124/125).
 *
 * No instancia su propio cliente Supabase: recibe el `SupabaseClient` por
 * constructor (inyección de dependencias). Quien componga este store debe
 * reutilizar `createSupabaseSportsDataClient` (WAT-106,
 * `modules/matches/infrastructure/supabase-sports-data-client.ts`) — el
 * mismo cliente servidor, sin duplicar el factory.
 */
export class SupabaseOwnProfileStore implements OwnProfileStore {
  constructor(private readonly client: SupabaseClient) {}

  /**
   * `userId` viene siempre del usuario autenticado (nunca de un input de
   * otra persona), así que la ausencia de fila es el único caso "vacío":
   * devuelve `null`, no lanza. Solo selecciona las tres columnas públicas
   * de `Profile` — nunca `user_id`, timestamps ni `*`.
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
   * 400) y deja las constraints de
   * `20260912160809_profiles_constraints.sql` como defensa final, no como
   * única defensa.
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

    if (input.favoriteTeamId !== null) {
      if (!UUID_PATTERN.test(input.favoriteTeamId)) {
        throw new ProfileValidationError(
          'favorite_team_not_found',
          `El equipo ${input.favoriteTeamId} no existe.`,
        );
      }

      if (!(await this.teamExists(input.favoriteTeamId))) {
        throw new ProfileValidationError(
          'favorite_team_not_found',
          `El equipo ${input.favoriteTeamId} no existe.`,
        );
      }
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

  /**
   * Solo se llama con un string que ya pasó `UUID_PATTERN`, así que acá no
   * hace falta interpretar códigos de error de formato inválido — un error
   * de Supabase en este punto es un fallo real de persistencia.
   */
  private async teamExists(teamId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('teams')
      .select('id')
      .eq('id', teamId)
      .maybeSingle();

    if (error) {
      throw new ProfilePersistenceError(`No se pudo verificar el equipo ${teamId}.`, error);
    }

    return data !== null;
  }
}
