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

  // 8. acquire_provider_sync_lease valida sus entradas: owner vacío o
  // duración no positiva deben rechazarse antes de tocar la fila.
  const emptyOwnerResult = await adminClient.rpc('acquire_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_owner: '   ',
  });
  results.push({
    label: 'acquire: rechaza un p_owner vacío',
    passed: emptyOwnerResult.error !== null,
    detail: emptyOwnerResult.error ? undefined : 'Debería haber fallado, no devolvió error.',
  });

  const nonPositiveDurationResult = await adminClient.rpc('acquire_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_owner: 'verify-script-invalid-duration',
    p_lease_duration: '0 seconds',
  });
  results.push({
    label: 'acquire: rechaza un p_lease_duration no positivo',
    passed: nonPositiveDurationResult.error !== null,
    detail: nonPositiveDurationResult.error
      ? undefined
      : 'Debería haber fallado, no devolvió error.',
  });

  // 9. Un lease vencido no debe poder cerrar una sincronización: si
  // release/record llegaran tarde con un token que ya expiró, no deben
  // tener efecto (evita que un worker colgado pise el turno de otro).
  const tokenE = await acquireLease(adminClient, 'verify-script-E');
  if (!tokenE) {
    throw new Error('No se pudo adquirir el lease para probar el vencimiento.');
  }

  const { error: forceExpireEError } = await adminClient
    .from('provider_sync_state')
    .update({ lease_expires_at: pastDate })
    .eq('provider', PROVIDER)
    .eq('competition_external_id', COMPETITION_EXTERNAL_ID)
    .eq('season', SEASON);
  if (forceExpireEError) {
    throw new Error(`No se pudo simular el vencimiento del lease: ${forceExpireEError.message}`);
  }

  const recordWithExpiredLease = await adminClient.rpc('record_provider_sync_result', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: tokenE,
    p_success: true,
  });
  results.push({
    label: 'record_provider_sync_result: no cierra la sincronización con un lease ya vencido',
    passed: recordWithExpiredLease.data === false,
    detail: recordWithExpiredLease.error?.message,
  });

  const reclaimExpiredE = await adminClient.rpc('reclaim_expired_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
  });
  results.push({
    label: 'reclaim: recupera el lease vencido dejado por el worker colgado',
    passed: reclaimExpiredE.data === true,
    detail: reclaimExpiredE.error?.message,
  });

  const tokenF = await acquireLease(adminClient, 'verify-script-F');
  results.push({
    label: 'acquire: adquiere un token nuevo tras recuperar el lease vencido',
    passed: tokenF !== null,
    detail: tokenF ? undefined : 'Debería haber devuelto un token, devolvió null.',
  });

  const staleReleaseAttempt = await adminClient.rpc('release_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: tokenE,
  });
  results.push({
    label: 'release: el token vencido no puede liberar el lease nuevo',
    passed: staleReleaseAttempt.data === false,
    detail: staleReleaseAttempt.error?.message,
  });

  const staleRecordAttempt = await adminClient.rpc('record_provider_sync_result', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: tokenE,
    p_success: true,
  });
  results.push({
    label: 'record_provider_sync_result: el token vencido no puede finalizar el lease nuevo',
    passed: staleRecordAttempt.data === false,
    detail: staleRecordAttempt.error?.message,
  });

  const stateAfterStaleAttempts = await readLeaseState(adminClient);
  results.push({
    label: 'el lease nuevo sigue en pie después de los intentos con el token vencido',
    passed:
      stateAfterStaleAttempts.lease_token === tokenF &&
      stateAfterStaleAttempts.lease_owner === 'verify-script-F',
    detail: `lease_owner=${stateAfterStaleAttempts.lease_owner}, lease_token=${stateAfterStaleAttempts.lease_token}`,
  });

  // Dejamos el registro libre para no interferir con otras corridas del script.
  const cleanupRelease = await adminClient.rpc('release_provider_sync_lease', {
    p_provider: PROVIDER,
    p_competition_external_id: COMPETITION_EXTERNAL_ID,
    p_season: SEASON,
    p_lease_token: tokenF,
  });
  if (cleanupRelease.error || cleanupRelease.data !== true) {
    throw new Error('No se pudo liberar el lease de prueba al finalizar checkLeaseLifecycle.');
  }

  return results;
}
