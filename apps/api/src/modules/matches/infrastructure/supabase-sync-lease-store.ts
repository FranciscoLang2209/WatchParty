import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncLeaseScope, SyncResultDetails } from '../domain/match-store.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';

/**
 * Coordinación del lease de sincronización (`provider_sync_state`, WAT-103).
 *
 * Separado de `SupabaseMatchStore` porque no comparte ninguna FK ni relación
 * con `teams`/`matches`: es un tema propio (turnos de sincronización con un
 * proveedor externo), a diferencia de `upsertFixture`, donde equipo y
 * partido sí están acoplados por FK y conviene mantenerlos juntos.
 *
 * Solo llama a las 4 funciones SQL que ya creó WAT-103 vía `.rpc(...)`;
 * nunca hace `.from('provider_sync_state')` directamente.
 */
export class SupabaseSyncLeaseStore {
  constructor(private readonly client: SupabaseClient) {}

  async acquireSyncLease(
    scope: SyncLeaseScope,
    owner: string,
    leaseDurationSeconds?: number,
  ): Promise<string | null> {
    const { data, error } = await this.client.rpc('acquire_provider_sync_lease', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
      p_owner: owner,
      ...(leaseDurationSeconds !== undefined
        ? { p_lease_duration: `${leaseDurationSeconds} seconds` }
        : {}),
    });

    if (error) {
      throw new SupabasePersistenceError('No se pudo adquirir el lease de sincronización.', error);
    }

    return data as string | null;
  }

  async reclaimExpiredSyncLease(scope: SyncLeaseScope): Promise<boolean> {
    const { data, error } = await this.client.rpc('reclaim_expired_provider_sync_lease', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
    });

    if (error) {
      throw new SupabasePersistenceError('No se pudo recuperar el lease vencido.', error);
    }

    return data === true;
  }

  async releaseSyncLease(scope: SyncLeaseScope, leaseToken: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('release_provider_sync_lease', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
      p_lease_token: leaseToken,
    });

    if (error) {
      throw new SupabasePersistenceError('No se pudo liberar el lease de sincronización.', error);
    }

    return data === true;
  }

  async recordSyncResult(
    scope: SyncLeaseScope,
    leaseToken: string,
    success: boolean,
    details?: SyncResultDetails,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('record_provider_sync_result', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
      p_lease_token: leaseToken,
      p_success: success,
      p_error: details?.error ?? null,
      p_observed_quota_remaining: details?.observedQuotaRemaining ?? null,
      p_observed_quota_window_reset_at: details?.observedQuotaWindowResetAt ?? null,
    });

    if (error) {
      throw new SupabasePersistenceError(
        'No se pudo registrar el resultado de la sincronización.',
        error,
      );
    }

    return data === true;
  }
}
