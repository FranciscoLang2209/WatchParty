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
const CANONICAL_MATCH_FIELDS = [
  'id',
  'homeTeam',
  'homeTeamId',
  'awayTeam',
  'awayTeamId',
  'kickoffAt',
  'status',
  'score',
];

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
    score: null,
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

  const { id: firstId } = await store.upsertFixture(buildFixture());
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

  const { id: secondId } = await store.upsertFixture(
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

  results.push(...(await checkMatchScore(adminClient, store, firstId)));

  const missingMatch = await store.findById('00000000-0000-0000-0000-000000000000');
  results.push({
    label: 'findById: devuelve null ante un id inexistente',
    passed: missingMatch === null,
    detail: missingMatch === null ? undefined : 'Debería haber devuelto null.',
  });

  return results;
}

function scoreLabel(match: { score: { home: number; away: number } | null } | null): string {
  if (!match) return 'partido no encontrado';
  return match.score ? `${match.score.home}-${match.score.away}` : 'sin marcador';
}

/**
 * Marcador real (WAT-230) contra Postgres: lo que un mock no puede probar es
 * la regla de `upsert_match_fixture` (un marcador ausente o incompleto no borra
 * uno confirmado) y el CHECK que impide guardar un solo gol.
 */
async function checkMatchScore(
  adminClient: SupabaseClient,
  store: SupabaseMatchStore,
  matchId: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // El partido de verificación se reutiliza entre corridas y un marcador
  // guardado ya no se borra por sincronización: se parte de "sin resultado".
  const reset = await adminClient
    .from('matches')
    .update({ home_score: null, away_score: null })
    .eq('id', matchId);
  if (reset.error) {
    throw new Error(`No se pudo limpiar el marcador de verificación: ${reset.error.message}`);
  }

  const withoutScore = await store.findById(matchId);
  results.push({
    label: 'marcador: un partido importado sin marcador devuelve score null, no 0–0',
    passed: withoutScore !== null && withoutScore.score === null,
    detail: scoreLabel(withoutScore),
  });

  await store.upsertFixture(buildFixture({ status: 'finished', score: { home: 0, away: 0 } }));
  const goalless = await store.findById(matchId);
  results.push({
    label: 'marcador: un 0–0 confirmado por el proveedor se guarda y se devuelve como 0–0',
    passed: goalless?.score?.home === 0 && goalless.score.away === 0,
    detail: scoreLabel(goalless),
  });

  await store.upsertFixture(buildFixture({ status: 'finished', score: null }));
  const afterMissing = await store.findById(matchId);
  results.push({
    label: 'marcador: una sincronización sin marcador no borra el resultado confirmado',
    passed: afterMissing?.score?.home === 0 && afterMissing.score.away === 0,
    detail: scoreLabel(afterMissing),
  });

  await store.upsertFixture(buildFixture({ status: 'finished', score: { home: 2, away: 1 } }));
  const corrected = await store.findById(matchId);
  results.push({
    label: 'marcador: un marcador nuevo reemplaza al anterior (corrección del proveedor)',
    passed: corrected?.score?.home === 2 && corrected.score.away === 1,
    detail: scoreLabel(corrected),
  });

  // Un marcador a medias solo puede llegar llamando a la función directo: el
  // normalizador nunca lo produce. Igual la base no debe mezclarlo.
  const partial = await adminClient.rpc('upsert_match_fixture', {
    p_provider: PROVIDER,
    p_external_id: EXTERNAL_MATCH_ID,
    p_home_team_external_id: HOME_TEAM_EXTERNAL_ID,
    p_home_team_name: 'Equipo Verificación A',
    p_away_team_external_id: AWAY_TEAM_EXTERNAL_ID,
    p_away_team_name: 'Equipo Verificación B',
    p_competition_external_id: 'verify-competition',
    p_season: '2026',
    p_kickoff_at: new Date().toISOString(),
    p_status: 'finished',
    p_home_score: 5,
    p_away_score: null,
  });
  const afterPartial = await store.findById(matchId);
  results.push({
    label: 'marcador: un marcador incompleto no pisa el confirmado ni mezcla goles',
    passed:
      partial.error == null && afterPartial?.score?.home === 2 && afterPartial.score.away === 1,
    detail: partial.error ? partial.error.message : scoreLabel(afterPartial),
  });

  // Compatibilidad de despliegue: un sync con el código anterior a WAT-230
  // llama con diez argumentos, sin goles. Debe seguir guardando el partido y
  // no tocar el marcador confirmado.
  const legacy = await adminClient.rpc('upsert_match_fixture', {
    p_provider: PROVIDER,
    p_external_id: EXTERNAL_MATCH_ID,
    p_home_team_external_id: HOME_TEAM_EXTERNAL_ID,
    p_home_team_name: 'Equipo Verificación A',
    p_away_team_external_id: AWAY_TEAM_EXTERNAL_ID,
    p_away_team_name: 'Equipo Verificación B',
    p_competition_external_id: 'verify-competition',
    p_season: '2026',
    p_kickoff_at: new Date().toISOString(),
    p_status: 'finished',
  });
  const afterLegacy = await store.findById(matchId);
  results.push({
    label:
      'marcador: un sync sin parámetros de goles (cliente anterior) sigue guardando el partido',
    passed:
      legacy.error == null &&
      afterLegacy?.status === 'finished' &&
      afterLegacy.score?.home === 2 &&
      afterLegacy.score.away === 1,
    detail: legacy.error ? legacy.error.message : scoreLabel(afterLegacy),
  });

  const matchCount = await adminClient
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .eq('provider', PROVIDER)
    .eq('external_id', EXTERNAL_MATCH_ID);
  results.push({
    label: 'marcador: actualizar el marcador no duplica el partido',
    passed: matchCount.error == null && matchCount.count === 1,
    detail: matchCount.error ? matchCount.error.message : `filas encontradas=${matchCount.count}`,
  });

  const halfScore = await adminClient
    .from('matches')
    .update({ away_score: null })
    .eq('id', matchId);
  results.push({
    label: 'marcador: la base rechaza un marcador con un solo gol (matches_score_complete)',
    passed: halfScore.error != null,
    detail: halfScore.error ? undefined : 'El update debería haber fallado.',
  });

  const negative = await adminClient.from('matches').update({ home_score: -1 }).eq('id', matchId);
  results.push({
    label: 'marcador: la base rechaza goles negativos',
    passed: negative.error != null,
    detail: negative.error ? undefined : 'El update debería haber fallado.',
  });

  return results;
}
