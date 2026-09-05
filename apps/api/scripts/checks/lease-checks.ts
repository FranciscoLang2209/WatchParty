import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';

// Scope ya sembrado en supabase/seed.sql — reusamos ese registro en vez de crear uno nuevo.
const PROVIDER = 'local-fixtures';
const COMPETITION_EXTERNAL_ID = 'liga-local';
const SEASON = '2026';

async function acquireLease(adminClient: SupabaseClient, owner: string): Promise<string | null> {
  const { data, error } = await adminClient.rpc('acquire_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_owner: owner,
  });
  if (error) {
    throw new Error(`acquire_provider_sync_lease falló inesperadamente: ${error.message}`);
  }
  return data as string | null;
}

async function readLeaseState(adminClient: SupabaseClient) {
  const { data, error } = await adminClient
    .from('provider_sync_state')
    .select('lease_owner, lease_token, lease_expires_at, last_success_at')
    .eq('provider', PROVIDER)
    .eq('competition_external_id', COMPETITION_EXTERNAL_ID)
    .eq('season', SEASON)
    .single();
  if (error) {
    throw new Error(`No se pudo leer provider_sync_state: ${error.message}`);
  }
  return data;
}

/**
 * Ejercita el ciclo de vida completo del lease sobre el registro sembrado
 * en supabase/seed.sql, siempre con el cliente service_role: en producción
 * este flujo lo maneja únicamente el proceso de sincronización del backend.
 */
export async function checkLeaseLifecycle(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Adquirir el lease libre (el seed lo deja sin dueño).
  const tokenA = await acquireLease(adminClient, 'verify-script-A');
  results.push({
    label: 'acquire: adquiere un lease libre',
    passed: tokenA !== null,
    detail: tokenA ? undefined : 'Debería haber devuelto un token, devolvió null.',
  });

  // 2. Un segundo "worker" no puede robarse un lease vigente.
  const tokenB = await acquireLease(adminClient, 'verify-script-B');
  results.push({
    label: 'acquire: no permite adquirir un lease ya tomado',
    passed: tokenB === null,
    detail: tokenB ? 'Debería haber devuelto null, devolvió un token nuevo.' : undefined,
  });

  // 3. release con un token equivocado no debe liberar nada.
  const releaseWrongToken = await adminClient.rpc('release_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: '00000000-0000-0000-0000-000000000000',
  });
  results.push({
    label: 'release: rechaza un token que no coincide con el dueño actual',
    passed: releaseWrongToken.data === false,
    detail: releaseWrongToken.error?.message,
  });

  // 4. release con el token correcto sí libera.
  const releaseCorrectToken = await adminClient.rpc('release_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: tokenA,
  });
  results.push({
    label: 'release: libera el lease con el token correcto',
    passed: releaseCorrectToken.data === true,
    detail: releaseCorrectToken.error?.message,
  });

  // 5. Liberado, ahora sí se puede volver a adquirir.
  const tokenC = await acquireLease(adminClient, 'verify-script-C');
  results.push({
    label: 'acquire: vuelve a adquirir un lease ya liberado',
    passed: tokenC !== null,
    detail: tokenC ? undefined : 'Debería haber devuelto un token, devolvió null.',
  });

  // 6. Simulamos un worker que se cayó sin liberar: forzamos que su lease
  // haya "vencido" directo por UPDATE, para no depender de esperar tiempo real.
  const pastDate = new Date(Date.now() - 60_000).toISOString();
  const { error: forceExpireError } = await adminClient
    .from('provider_sync_state')
    .update({ lease_expires_at: pastDate })
    .eq('provider', PROVIDER)
    .eq('competition_external_id', COMPETITION_EXTERNAL_ID)
    .eq('season', SEASON);
  if (forceExpireError) {
    throw new Error(`No se pudo simular el vencimiento del lease: ${forceExpireError.message}`);
  }

  const reclaimResult = await adminClient.rpc('reclaim_expired_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
  });
  results.push({
    label: 'reclaim: recupera un lease vencido',
    passed: reclaimResult.data === true,
    detail: reclaimResult.error?.message,
  });

  const stateAfterReclaim = await readLeaseState(adminClient);
  results.push({
    label: 'reclaim: deja el lease sin dueño después de recuperarlo',
    passed: stateAfterReclaim.lease_token === null && stateAfterReclaim.lease_owner === null,
    detail: `lease_owner=${stateAfterReclaim.lease_owner}, lease_token=${stateAfterReclaim.lease_token}`,
  });

  // 7. Ciclo normal completo: adquirir y cerrar con record_provider_sync_result.
  const tokenD = await acquireLease(adminClient, 'verify-script-D');
  if (!tokenD) {
    throw new Error('No se pudo adquirir el lease para probar record_provider_sync_result.');
  }

  const recordWrongToken = await adminClient.rpc('record_provider_sync_result', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: '00000000-0000-0000-0000-000000000000',
    p_success: true,
  });
  results.push({
    label: 'record_provider_sync_result: rechaza un token que no coincide',
    passed: recordWrongToken.data === false,
    detail: recordWrongToken.error?.message,
  });

  const recordCorrectToken = await adminClient.rpc('record_provider_sync_result', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: tokenD,
    p_success: true,
  });
  results.push({
    label: 'record_provider_sync_result: registra éxito y libera el lease',
    passed: recordCorrectToken.data === true,
    detail: recordCorrectToken.error?.message,
  });

  const finalState = await readLeaseState(adminClient);
  results.push({
    label: 'record_provider_sync_result: deja last_success_at actualizado y el lease libre',
    passed: finalState.last_success_at !== null && finalState.lease_token === null,
    detail: `last_success_at=${finalState.last_success_at}, lease_token=${finalState.lease_token}`,
  });

  return results;
}
