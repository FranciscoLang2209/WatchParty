import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseSyncLeaseStore } from './supabase-sync-lease-store.js';

type FakeResult = { data: unknown; error: { message: string } | null };

function makeFakeClient(result: FakeResult = { data: true, error: null }) {
  const rpc = vi.fn<(fn: string, params: Record<string, unknown>) => Promise<FakeResult>>(
    async () => result,
  );
  return { rpc };
}

function asSupabaseClient(fakeClient: ReturnType<typeof makeFakeClient>): SupabaseClient {
  return fakeClient as unknown as SupabaseClient;
}

const SCOPE = { provider: 'api-football', competitionExternalId: 'liga-1', season: '2026' };

describe('SupabaseSyncLeaseStore', () => {
  describe('recordSyncResult() — sanitización de details.error', () => {
    it('sin details, p_error es null', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));

      await store.recordSyncResult(SCOPE, 'token-1', true);

      expect(client.rpc).toHaveBeenCalledWith(
        'record_provider_sync_result',
        expect.objectContaining({ p_error: null }),
      );
    });

    it('con details.error undefined, p_error es null', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));

      await store.recordSyncResult(SCOPE, 'token-1', false, {});

      expect(client.rpc).toHaveBeenCalledWith(
        'record_provider_sync_result',
        expect.objectContaining({ p_error: null }),
      );
    });

    it('un mensaje multilínea se colapsa a una sola línea', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));

      await store.recordSyncResult(SCOPE, 'token-1', false, {
        error: 'línea uno\nlínea dos\n\tcon tab',
      });

      const [, params] = client.rpc.mock.calls[0]!;
      expect(params.p_error).toBe('línea uno línea dos con tab');
    });

    it('un mensaje larguísimo se trunca al límite máximo', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));
      const longMessage = 'fallo de red intermitente al conectar con el proveedor '.repeat(10);

      await store.recordSyncResult(SCOPE, 'token-1', false, { error: longMessage });

      const [, params] = client.rpc.mock.calls[0]!;
      expect(params.p_error).toHaveLength(300);
      expect(params.p_error).toMatch(/…$/);
    });

    it('un Error real nunca persiste su .message ni su stack — cae al mensaje genérico', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));
      const realError = new Error('token secreto: sk_live_abc123, credenciales expuestas');

      await store.recordSyncResult(SCOPE, 'token-1', false, {
        error: realError as unknown as string,
      });

      const [, params] = client.rpc.mock.calls[0]!;
      expect(params.p_error).toBe('Error desconocido durante la sincronización.');
      expect(params.p_error).not.toContain('sk_live_abc123');
      expect(params.p_error).not.toContain('at ');
      expect(params.p_error).not.toContain('.ts:');
    });

    it('un objeto que no es Error ni string también cae al mensaje genérico', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));

      await store.recordSyncResult(SCOPE, 'token-1', false, {
        error: { unexpected: 'shape' } as unknown as string,
      });

      const [, params] = client.rpc.mock.calls[0]!;
      expect(params.p_error).toBe('Error desconocido durante la sincronización.');
    });

    it('redacta una URL dentro de un mensaje string', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));

      await store.recordSyncResult(SCOPE, 'token-1', false, {
        error: 'fallo al conectar con https://internal-db.watchparty.local:5432/sync?token=abc',
      });

      const [, params] = client.rpc.mock.calls[0]!;
      expect(params.p_error).toBe('fallo al conectar con [redactado]');
      expect(params.p_error).not.toContain('internal-db.watchparty.local');
    });

    it('redacta un token largo dentro de un mensaje string', async () => {
      const client = makeFakeClient();
      const store = new SupabaseSyncLeaseStore(asSupabaseClient(client));

      await store.recordSyncResult(SCOPE, 'token-1', false, {
        error: 'rate limit excedido, api key aBcDeFgHiJkLmNoPqRsTuVwXyZ012345 inválida',
      });

      const [, params] = client.rpc.mock.calls[0]!;
      expect(params.p_error).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
      expect(params.p_error).toContain('[redactado]');
    });
  });
});
