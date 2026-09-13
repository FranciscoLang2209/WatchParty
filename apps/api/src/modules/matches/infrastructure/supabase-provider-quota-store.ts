import type { SupabaseClient } from '@supabase/supabase-js';
import type { QuotaReservationResult } from '../domain/match-store.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';

/**
 * Ledger de cuota diaria (`provider_quota_ledger`, complemento de WAT-103).
 * Solo llama a `reserve_provider_quota_unit` vía `.rpc(...)`; nunca hace
 * `.from('provider_quota_ledger')` directamente, mismo criterio que
 * `SupabaseSyncLeaseStore` para el lease.
 */
export class SupabaseProviderQuotaStore {
  constructor(private readonly client: SupabaseClient) {}

  async reserveProviderQuotaUnit(
    provider: string,
    quotaDateUtc: string,
    dailyLimit: number,
  ): Promise<QuotaReservationResult> {
    const { data, error } = await this.client.rpc('reserve_provider_quota_unit', {
      p_provider: provider,
      p_quota_date: quotaDateUtc,
      p_daily_limit: dailyLimit,
    });

    if (error) {
      throw new SupabasePersistenceError(
        'No se pudo reservar la cuota diaria del proveedor.',
        error,
      );
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      reserved: boolean;
      reserved_count: number;
    };

    return { reserved: row.reserved, reservedCount: row.reserved_count };
  }
}
