import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';

// IDs/valores fijos de supabase/seed.sql — no se generan acá para no depender
// de una consulta previa.
const SEED_TEAM_1_ID = '11111111-1111-1111-1111-111111111111';
const SEED_TEAM_2_ID = '22222222-2222-2222-2222-222222222222';
const SEED_MATCH_PROVIDER = 'local-fixtures';
const SEED_MATCH_EXTERNAL_ID = 'match-1'; // ya existe en supabase/seed.sql
const SEED_SYNC_STATE = {
  provider: 'local-fixtures',
  competition_external_id: 'liga-local',
  season: '2026', // ya existe en supabase/seed.sql
};
const NONEXISTENT_TEAM_ID = '99999999-9999-9999-9999-999999999999';

/** Payload base de un partido válido, para variar un solo campo por test. */
function validMatchPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'verify-script',
    external_id: `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    home_team_id: SEED_TEAM_1_ID,
    away_team_id: SEED_TEAM_2_ID,
    competition_external_id: 'verify-script',
    season: '2026',
    kickoff_at: new Date().toISOString(),
    status: 'scheduled',
    ...overrides,
  };
}

/**
 * Verifica que la base de datos rechace datos inválidos por sí misma.
 * Usa el cliente service_role porque acá nos interesa aislar el
 * comportamiento de los constraints, no el de RLS/permisos (eso va en
 * rls-checks.ts). Cada intento debe fallar sin modificar los datos válidos
 * que ya estaban sembrados.
 */
export async function checkConstraints(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // CHECK matches_distinct_teams: un partido no puede tener el mismo equipo como local y visitante.
  const sameTeamsResult = await adminClient
    .from('matches')
    .insert(validMatchPayload({ home_team_id: SEED_TEAM_1_ID, away_team_id: SEED_TEAM_1_ID }));

  results.push({
    label: 'CHECK matches_distinct_teams rechaza home_team_id = away_team_id',
    passed: sameTeamsResult.error?.code === '23514',
    detail: sameTeamsResult.error
      ? `Postgres devolvió: ${sameTeamsResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // UNIQUE teams_provider_external_id_key: no puede haber dos equipos con el mismo (provider, external_id).
  const duplicateTeamResult = await adminClient.from('teams').insert({
    provider: 'local-fixtures',
    external_id: 'team-1', // ya existe en supabase/seed.sql
    name: 'Equipo duplicado de prueba',
  });

  results.push({
    label: 'UNIQUE teams_provider_external_id_key rechaza (provider, external_id) duplicado',
    passed: duplicateTeamResult.error?.code === '23505',
    detail: duplicateTeamResult.error
      ? `Postgres devolvió: ${duplicateTeamResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // UNIQUE matches_provider_external_id_key: no puede haber dos partidos con el mismo (provider, external_id).
  const duplicateMatchResult = await adminClient.from('matches').insert(
    validMatchPayload({
      provider: SEED_MATCH_PROVIDER,
      external_id: SEED_MATCH_EXTERNAL_ID, // ya existe en supabase/seed.sql
    }),
  );

  results.push({
    label: 'UNIQUE matches_provider_external_id_key rechaza (provider, external_id) duplicado',
    passed: duplicateMatchResult.error?.code === '23505',
    detail: duplicateMatchResult.error
      ? `Postgres devolvió: ${duplicateMatchResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // UNIQUE provider_sync_state_scope_key: no puede haber dos estados con el mismo (provider, competition_external_id, season).
  const duplicateSyncStateResult = await adminClient
    .from('provider_sync_state')
    .insert(SEED_SYNC_STATE);

  results.push({
    label:
      'UNIQUE provider_sync_state_scope_key rechaza (provider, competition_external_id, season) duplicado',
    passed: duplicateSyncStateResult.error?.code === '23505',
    detail: duplicateSyncStateResult.error
      ? `Postgres devolvió: ${duplicateSyncStateResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // FK matches_home_team_id_fkey: home_team_id debe existir en teams.
  const missingHomeTeamResult = await adminClient
    .from('matches')
    .insert(validMatchPayload({ home_team_id: NONEXISTENT_TEAM_ID }));

  results.push({
    label: 'FK rechaza home_team_id inexistente',
    passed: missingHomeTeamResult.error?.code === '23503',
    detail: missingHomeTeamResult.error
      ? `Postgres devolvió: ${missingHomeTeamResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // FK matches_away_team_id_fkey: away_team_id debe existir en teams.
  const missingAwayTeamResult = await adminClient
    .from('matches')
    .insert(validMatchPayload({ away_team_id: NONEXISTENT_TEAM_ID }));

  results.push({
    label: 'FK rechaza away_team_id inexistente',
    passed: missingAwayTeamResult.error?.code === '23503',
    detail: missingAwayTeamResult.error
      ? `Postgres devolvió: ${missingAwayTeamResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // CHECK sobre status: solo se permiten scheduled/live/finished/postponed/cancelled.
  const invalidStatusResult = await adminClient
    .from('matches')
    .insert(validMatchPayload({ status: 'archived' }));

  results.push({
    label: 'CHECK status rechaza un valor fuera de scheduled/live/finished/postponed/cancelled',
    passed: invalidStatusResult.error?.code === '23514',
    detail: invalidStatusResult.error
      ? `Postgres devolvió: ${invalidStatusResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  return results;
}
