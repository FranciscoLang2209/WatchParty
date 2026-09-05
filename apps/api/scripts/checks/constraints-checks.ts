import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';

// IDs fijos de supabase/seed.sql — no se generan acá para no depender de una consulta previa.
const SEED_TEAM_1_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Verifica que la base de datos rechace datos inválidos por sí misma.
 * Usa el cliente service_role porque acá nos interesa aislar el
 * comportamiento de los constraints, no el de RLS (eso va en rls-checks.ts).
 */
export async function checkConstraints(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // CHECK matches_distinct_teams: un partido no puede tener el mismo equipo como local y visitante.
  const sameTeamsResult = await adminClient.from('matches').insert({
    provider: 'verify-script',
    external_id: `check-distinct-teams-${Date.now()}`,
    home_team_id: SEED_TEAM_1_ID,
    away_team_id: SEED_TEAM_1_ID,
    competition_external_id: 'verify-script',
    season: '2026',
    kickoff_at: new Date().toISOString(),
    status: 'scheduled',
  });

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

  return results;
}
