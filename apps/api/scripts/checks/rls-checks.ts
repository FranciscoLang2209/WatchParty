import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';

const TABLES = ['teams', 'matches', 'provider_sync_state'] as const;

/**
 * Verifica que ni un visitante anónimo ni un usuario autenticado común
 * puedan leer ni escribir datos deportivos. El único acceso privilegiado
 * es vía service_role, que en este proyecto solo usa el backend (Node).
 */
export async function checkRls(
  anonClient: SupabaseClient,
  authenticatedClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const table of TABLES) {
    const anonRead = await anonClient.from(table).select('*');
    results.push({
      label: `RLS: anon no puede leer "${table}"`,
      passed: !anonRead.error && (anonRead.data?.length ?? 0) === 0,
      detail: anonRead.error
        ? `Error inesperado: ${anonRead.error.message}`
        : `Filas devueltas: ${anonRead.data?.length ?? 0}`,
    });

    const authenticatedRead = await authenticatedClient.from(table).select('*');
    results.push({
      label: `RLS: un usuario autenticado no puede leer "${table}"`,
      passed: !authenticatedRead.error && (authenticatedRead.data?.length ?? 0) === 0,
      detail: authenticatedRead.error
        ? `Error inesperado: ${authenticatedRead.error.message}`
        : `Filas devueltas: ${authenticatedRead.data?.length ?? 0}`,
    });
  }

  // Además de lectura, confirmamos que tampoco se puede escribir sin service_role.
  const anonWrite = await anonClient.from('teams').insert({
    provider: 'verify-script',
    external_id: `rls-write-${Date.now()}`,
    name: 'Equipo de prueba RLS',
  });
  results.push({
    label: 'RLS: anon no puede insertar en "teams"',
    passed: anonWrite.error?.code === '42501',
    detail: anonWrite.error
      ? `Postgres devolvió: ${anonWrite.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  return results;
}
