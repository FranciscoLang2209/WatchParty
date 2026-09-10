import type { SupabaseClient } from '@supabase/supabase-js';
import type { Match, MatchStatus } from '../domain/match.js';
import type { MatchStore, SyncLeaseScope, SyncResultDetails } from '../domain/match-store.js';
import type { NormalizedMatchFixture } from '../domain/normalized-match-fixture.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';
import { SupabaseSyncLeaseStore } from './supabase-sync-lease-store.js';

// Postgres nombra así, por convención, la FK inline sin nombre explícito
// (`<tabla>_<columna>_fkey`) que definió la migración de WAT-103
// (20260904222112_sports_data_schema.sql). Hacemos explícito el hint de
// relación porque `matches` tiene dos FKs a `teams` y PostgREST no puede
// adivinar cuál embeber en cada alias.
const MATCH_SELECT_WITH_TEAMS =
  'id, kickoff_at, status, home_team:teams!matches_home_team_id_fkey(name), away_team:teams!matches_away_team_id_fkey(name)';

const MATCH_STATUSES: readonly MatchStatus[] = [
  'scheduled',
  'live',
  'finished',
  'postponed',
  'cancelled',
];

function isMatchStatus(value: string): value is MatchStatus {
  return (MATCH_STATUSES as readonly string[]).includes(value);
}

interface EmbeddedTeamName {
  name: string;
}

interface MatchRowWithTeams {
  id: string;
  kickoff_at: string;
  status: string;
  home_team: EmbeddedTeamName | null;
  away_team: EmbeddedTeamName | null;
}

function toMatch(row: MatchRowWithTeams): Match {
  if (!row.home_team || !row.away_team) {
    throw new SupabasePersistenceError(
      `El partido ${row.id} no pudo resolver sus equipos desde la relación.`,
    );
  }

  if (!isMatchStatus(row.status)) {
    throw new SupabasePersistenceError(
      `El partido ${row.id} tiene un status fuera del contrato canónico de Match.`,
    );
  }

  return {
    id: row.id,
    homeTeam: row.home_team.name,
    awayTeam: row.away_team.name,
    kickoffAt: new Date(row.kickoff_at).toISOString(),
    status: row.status,
  };
}

/**
 * Implementación de `MatchStore` respaldada por Supabase (WAT-106).
 *
 * Solo se ocupa de `teams` y `matches` (acopladas por FK: un partido
 * siempre necesita el UUID de ambos equipos). El lease de sincronización
 * (`provider_sync_state`, sin relación con estas dos tablas) vive aparte en
 * `SupabaseSyncLeaseStore`, compuesta acá adentro — `MatchStore` sigue
 * siendo una única interfaz para quien la consuma (WAT-107).
 */
export class SupabaseMatchStore implements MatchStore {
  private readonly syncLeaseStore: SupabaseSyncLeaseStore;

  constructor(private readonly client: SupabaseClient) {
    this.syncLeaseStore = new SupabaseSyncLeaseStore(client);
  }

  async list(): Promise<readonly Match[]> {
    const { data, error } = await this.client.from('matches').select(MATCH_SELECT_WITH_TEAMS);

    if (error) {
      throw new SupabasePersistenceError('No se pudo listar los partidos.', error);
    }

    return (data as unknown as MatchRowWithTeams[]).map(toMatch);
  }

  async findById(id: string): Promise<Match | null> {
    const { data, error } = await this.client
      .from('matches')
      .select(MATCH_SELECT_WITH_TEAMS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new SupabasePersistenceError(`No se pudo buscar el partido ${id}.`, error);
    }

    if (!data) return null;

    return toMatch(data as unknown as MatchRowWithTeams);
  }

  async upsertFixture(fixture: NormalizedMatchFixture): Promise<string> {
    // Una sola llamada a upsert_match_fixture (fix de atomicidad, comentario
    // del jefe en WAT-106): equipos y partido se guardan dentro de la misma
    // transacción de Postgres. Si el partido es inválido (por ejemplo
    // home == away), la función revierte también los upserts de equipos que
    // haya hecho antes de fallar — ver la migración
    // 20260910120000_upsert_match_fixture_function.sql.
    const { data, error } = await this.client.rpc('upsert_match_fixture', {
      p_provider: fixture.provider,
      p_external_id: fixture.externalId,
      p_home_team_external_id: fixture.homeTeam.externalId,
      p_home_team_name: fixture.homeTeam.name,
      p_away_team_external_id: fixture.awayTeam.externalId,
      p_away_team_name: fixture.awayTeam.name,
      p_competition_external_id: fixture.competitionExternalId,
      p_season: fixture.season,
      p_kickoff_at: fixture.kickoffAt,
      p_status: fixture.status,
    });

    if (error) {
      throw new SupabasePersistenceError(
        `No se pudo guardar el partido ${fixture.provider}/${fixture.externalId}.`,
        error,
      );
    }

    return data as string;
  }

  // Delegación pura: la lógica real vive en SupabaseSyncLeaseStore.
  async acquireSyncLease(
    scope: SyncLeaseScope,
    owner: string,
    leaseDurationSeconds?: number,
  ): Promise<string | null> {
    return this.syncLeaseStore.acquireSyncLease(scope, owner, leaseDurationSeconds);
  }

  async reclaimExpiredSyncLease(scope: SyncLeaseScope): Promise<boolean> {
    return this.syncLeaseStore.reclaimExpiredSyncLease(scope);
  }

  async releaseSyncLease(scope: SyncLeaseScope, leaseToken: string): Promise<boolean> {
    return this.syncLeaseStore.releaseSyncLease(scope, leaseToken);
  }

  async recordSyncResult(
    scope: SyncLeaseScope,
    leaseToken: string,
    success: boolean,
    details?: SyncResultDetails,
  ): Promise<boolean> {
    return this.syncLeaseStore.recordSyncResult(scope, leaseToken, success, details);
  }
}
