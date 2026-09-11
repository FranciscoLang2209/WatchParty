import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { SupabaseMatchStore } from '../../src/modules/matches/infrastructure/supabase-match-store.js';
import type { NormalizedMatchFixture } from '../../src/modules/matches/domain/normalized-match-fixture.js';

// Scope propio, aislado del sembrado en supabase/seed.sql, para no
// interferir con checkConstraints/checkLeaseLifecycle ni con la demo local.
const PROVIDER = 'verify-script-store';
const EXTERNAL_MATCH_ID = 'verify-store-match-1';
const HOME_TEAM_EXTERNAL_ID = 'verify-store-team-a';
const AWAY_TEAM_EXTERNAL_ID = 'verify-store-team-b';
const CANONICAL_MATCH_FIELDS = ['id', 'homeTeam', 'awayTeam', 'kickoffAt', 'status'];

// Externa a las anteriores a propósito: nunca la usa ningún otro check de
// este archivo, así que si aparece una fila para este external_id después
// de un intento fallido, solo puede venir de ESTE intento — no hay forma
// de confundirla con datos de otro check.
const ROLLBACK_MATCH_EXTERNAL_ID = 'verify-store-match-rollback';
const ROLLBACK_TEAM_EXTERNAL_ID = 'verify-store-team-rollback';

function buildFixture(overrides: Partial<NormalizedMatchFixture> = {}): NormalizedMatchFixture {
  return {
    provider: PROVIDER,
    externalId: EXTERNAL_MATCH_ID,
    homeTeam: { externalId: HOME_TEAM_EXTERNAL_ID, name: 'Equipo Verificación A' },
    awayTeam: { externalId: AWAY_TEAM_EXTERNAL_ID, name: 'Equipo Verificación B' },
    competitionExternalId: 'verify-competition',
    season: '2026',
    kickoffAt: new Date().toISOString(),
    status: 'scheduled',
    ...overrides,
  };
}

/**
 * Ejercita `SupabaseMatchStore` (WAT-106) contra el esquema real de
 * WAT-103, usando el mismo adaptador que compone `server.ts` — no queries
 * ad-hoc — para que esta evidencia hable del comportamiento real del store,
 * no de una reimplementación paralela. Cubre justamente lo que un mock no
 * puede probar: idempotencia y atomicidad reales de Postgres.
 */
export async function checkMatchStore(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const store = new SupabaseMatchStore(adminClient);

  const firstId = await store.upsertFixture(buildFixture());
  const firstMatch = await store.findById(firstId);

  results.push({
    label:
      'upsertFixture: la primera importación crea el partido y resuelve nombres desde las relaciones',
    passed:
      firstMatch !== null &&
      firstMatch.homeTeam === 'Equipo Verificación A' &&
      firstMatch.awayTeam === 'Equipo Verificación B' &&
      firstMatch.status === 'scheduled',
    detail: firstMatch ? undefined : 'findById devolvió null para un id recién creado.',
  });

  results.push({
    label: 'findById: el Match devuelto expone exactamente los campos del contrato canónico',
    passed:
      firstMatch !== null &&
      Object.keys(firstMatch).sort().join(',') === [...CANONICAL_MATCH_FIELDS].sort().join(','),
    detail: firstMatch ? `Campos: ${Object.keys(firstMatch).join(', ')}` : undefined,
  });

  const secondId = await store.upsertFixture(
    buildFixture({
      homeTeam: { externalId: HOME_TEAM_EXTERNAL_ID, name: 'Equipo Verificación A (actualizado)' },
      status: 'live',
    }),
  );

  results.push({
    label: 'upsertFixture: reimportar el mismo (provider, externalId) conserva el UUID interno',
    passed: secondId === firstId,
    detail: `firstId=${firstId}, secondId=${secondId}`,
  });

  const updatedMatch = await store.findById(firstId);
  results.push({
    label: 'upsertFixture: la reimportación actualiza los datos (nombre de equipo y status)',
    passed:
      updatedMatch !== null &&
      updatedMatch.homeTeam === 'Equipo Verificación A (actualizado)' &&
      updatedMatch.status === 'live',
    detail: updatedMatch
      ? `homeTeam=${updatedMatch.homeTeam}, status=${updatedMatch.status}`
      : undefined,
  });

  const teamCountResult = await adminClient
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('provider', PROVIDER)
    .eq('external_id', HOME_TEAM_EXTERNAL_ID);

  results.push({
    label: 'upsertFixture: el equipo se actualiza in place, no se duplica',
    passed: teamCountResult.error == null && teamCountResult.count === 1,
    detail: teamCountResult.error
      ? teamCountResult.error.message
      : `filas encontradas=${teamCountResult.count}`,
  });

  let invalidUpsertRejected = false;
  try {
    // home == away: viola el CHECK matches_distinct_teams.
    await store.upsertFixture(
      buildFixture({
        awayTeam: { externalId: HOME_TEAM_EXTERNAL_ID, name: 'Equipo Verificación A' },
      }),
    );
  } catch {
    invalidUpsertRejected = true;
  }

  results.push({
    label:
      'upsertFixture: propaga el error de Supabase cuando el mismo equipo es local y visitante',
    passed: invalidUpsertRejected,
    detail: invalidUpsertRejected ? undefined : 'Debería haber lanzado, no lanzó nada.',
  });

  const matchAfterFailedWrite = await store.findById(firstId);
  results.push({
    label: 'un intento inválido no corrompe los datos válidos existentes',
    passed:
      matchAfterFailedWrite !== null &&
      matchAfterFailedWrite.status === 'live' &&
      matchAfterFailedWrite.homeTeam === 'Equipo Verificación A (actualizado)',
    detail: matchAfterFailedWrite
      ? undefined
      : 'El partido válido desapareció tras el intento inválido.',
  });

  // Prueba de rollback (comentario del jefe en WAT-106): un fixture inválido
  // con equipos NUEVOS, nunca creados antes, no debe dejar ningún rastro.
  // upsert_match_fixture intenta crear el equipo local primero y recién
  // después falla en el insert del partido (mismo external_id para local y
  // visitante viola matches_distinct_teams) — si la función es atómica,
  // Postgres revierte también ese insert de equipo. Con el código viejo
  // (tres upserts HTTP independientes), el equipo ya habría quedado creado
  // a pesar del error.
  let rollbackFixtureRejected = false;
  try {
    await store.upsertFixture(
      buildFixture({
        externalId: ROLLBACK_MATCH_EXTERNAL_ID,
        homeTeam: { externalId: ROLLBACK_TEAM_EXTERNAL_ID, name: 'Equipo Rollback' },
        awayTeam: { externalId: ROLLBACK_TEAM_EXTERNAL_ID, name: 'Equipo Rollback' },
      }),
    );
  } catch {
    rollbackFixtureRejected = true;
  }

  results.push({
    label: 'upsertFixture: un fixture inválido con equipos nuevos también se rechaza',
    passed: rollbackFixtureRejected,
    detail: rollbackFixtureRejected ? undefined : 'Debería haber lanzado, no lanzó nada.',
  });

  const rollbackTeamCount = await adminClient
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('provider', PROVIDER)
    .eq('external_id', ROLLBACK_TEAM_EXTERNAL_ID);

  results.push({
    label:
      'upsertFixture: el rollback revierte también el equipo creado antes de que fallara el partido',
    passed: rollbackTeamCount.error == null && rollbackTeamCount.count === 0,
    detail: rollbackTeamCount.error
      ? rollbackTeamCount.error.message
      : `filas encontradas=${rollbackTeamCount.count} (esperado: 0)`,
  });

  const missingMatch = await store.findById('00000000-0000-0000-0000-000000000000');
  results.push({
    label: 'findById: devuelve null ante un id inexistente',
    passed: missingMatch === null,
    detail: missingMatch === null ? undefined : 'Debería haber devuelto null.',
  });

  return results;
}
