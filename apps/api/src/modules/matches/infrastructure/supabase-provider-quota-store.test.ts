import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseProviderQuotaStore } from './supabase-provider-quota-store.js';

type FakeResult = { data: unknown; error: { message: string } | null };

function makeFakeClient(result: FakeResult) {
  const rpc = vi.fn<(fn: string, params: Record<string, unknown>) => Promise<FakeResult>>(
    async () => result,
  );
  return { rpc };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

describe('SupabaseProviderQuotaStore', () => {
  it('reserva una unidad cuando hay presupuesto disponible', async () => {
    const client = makeFakeClient({ data: [{ reserved: true, reserved_count: 5 }], error: null });
    const store = new SupabaseProviderQuotaStore(asSupabaseClient(client));

    const result = await store.reserveProviderQuotaUnit('api-football', '2026-09-12', 80);

    expect(result).toEqual({ reserved: true, reservedCount: 5 });
    expect(client.rpc).toHaveBeenCalledWith('reserve_provider_quota_unit', {
      p_provider: 'api-football',
      p_quota_date: '2026-09-12',
      p_daily_limit: 80,
    });
  });

  it('no reserva cuando ya se alcanzó el límite diario', async () => {
    const client = makeFakeClient({ data: [{ reserved: false, reserved_count: 80 }], error: null });
    const store = new SupabaseProviderQuotaStore(asSupabaseClient(client));

    const result = await store.reserveProviderQuotaUnit('api-football', '2026-09-12', 80);

    expect(result).toEqual({ reserved: false, reservedCount: 80 });
  });

  it('propaga un error de Supabase en vez de devolver un resultado ficticio', async () => {
    const client = makeFakeClient({ data: null, error: { message: 'connection lost' } });
    const store = new SupabaseProviderQuotaStore(asSupabaseClient(client));

    await expect(store.reserveProviderQuotaUnit('api-football', '2026-09-12', 80)).rejects.toThrow(
      'No se pudo reservar la cuota diaria del proveedor.',
    );
  });
});
