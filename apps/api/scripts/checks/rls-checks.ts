import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';

const TABLES = ['teams', 'matches', 'provider_sync_state'] as const;
type Table = (typeof TABLES)[number];

const PERMISSION_DENIED = '42501';

// IDs/valores ya sembrados en supabase/seed.sql. Se usan como target de
// update/delete: no hace falta que la fila exista para demostrar el
// permiso denegado (el GRANT se revoca a nivel de tabla, antes de que
// Postgres llegue a evaluar el WHERE), pero usar filas reales evita
// cualquier ambigüedad sobre qué se está probando.
const SEED_TEAM_1_ID = '11111111-1111-1111-1111-111111111111';
const SEED_MATCH_1_ID = 'a1111111-1111-1111-1111-111111111111';
const SEED_SYNC_STATE = {
  provider: 'local-fixtures',
  competition_external_id: 'liga-local',
  season: '2026',
};

/** Payload válido para un INSERT de prueba: no debe violar FK, UNIQUE ni CHECK. */
function validInsertPayload(table: Table): Record<string, unknown> {
  const unique = `rls-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  switch (table) {
    case 'teams':
      return {
        provider: 'rls-check',
        external_id: unique,
        name: 'Equipo de prueba RLS',
      };
    case 'matches':
      return {
        provider: 'rls-check',
        external_id: unique,
        // Dos equipos distintos ya sembrados, para no depender de un INSERT
        // previo (que igual estaría bloqueado por RLS/permisos).
        home_team_id: '11111111-1111-1111-1111-111111111111',
        away_team_id: '22222222-2222-2222-2222-222222222222',
        competition_external_id: 'rls-check',
        season: '2026',
        kickoff_at: new Date().toISOString(),
        status: 'scheduled',
      };
    case 'provider_sync_state':
      return {
        provider: 'rls-check',
        competition_external_id: unique,
        season: '2026',
      };
  }
}

/** Filtro para dirigir un UPDATE/DELETE de prueba a una fila sembrada. */
function seedRowFilter(table: Table): Record<string, string> {
  switch (table) {
    case 'teams':
      return { id: SEED_TEAM_1_ID };
    case 'matches':
      return { id: SEED_MATCH_1_ID };
    case 'provider_sync_state':
      return SEED_SYNC_STATE;
  }
}

/**
 * Verifica que ni un visitante anónimo ni un usuario autenticado común
 * puedan leer ni escribir datos deportivos. El único acceso privilegiado
 * es vía service_role, que en este proyecto solo usa el backend (Node).
 *
 * Importante: desde que la migración revoca los GRANT de tabla para
 * anon/authenticated (además de habilitar RLS), cualquier intento de
 * SELECT/INSERT/UPDATE/DELETE de esos roles debe fallar con el código
 * 42501 ("permission denied"), no devolver una lista vacía o un éxito
 * silencioso — eso demuestra que el rechazo ocurre a nivel de permisos
 * de tabla y no solo por falta de políticas de RLS.
 */
export async function checkRls(
  anonClient: SupabaseClient,
  authenticatedClient: SupabaseClient,
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const roles: Array<{ label: string; client: SupabaseClient }> = [
    { label: 'anon', client: anonClient },
    { label: 'un usuario autenticado', client: authenticatedClient },
  ];

  for (const table of TABLES) {
    for (const role of roles) {
      const read = await role.client.from(table).select('*');
      results.push({
        label: `RLS: ${role.label} no puede leer "${table}"`,
        passed: read.error?.code === PERMISSION_DENIED,
        detail: read.error
          ? `Postgres devolvió: ${read.error.message} (code=${read.error.code})`
          : `La lectura no fue rechazada (devolvió ${read.data?.length ?? 0} filas).`,
      });

      const insert = await role.client.from(table).insert(validInsertPayload(table));
      results.push({
        label: `RLS: ${role.label} no puede insertar en "${table}"`,
        passed: insert.error?.code === PERMISSION_DENIED,
        detail: insert.error
          ? `Postgres devolvió: ${insert.error.message} (code=${insert.error.code})`
          : 'La inserción no fue rechazada (no debería haber tenido éxito).',
      });

      let updateQuery = role.client.from(table).update({ updated_at: new Date().toISOString() });
      for (const [column, value] of Object.entries(seedRowFilter(table))) {
        updateQuery = updateQuery.eq(column, value);
      }
      const updateResult = await updateQuery;
      results.push({
        label: `RLS: ${role.label} no puede actualizar "${table}"`,
        passed: updateResult.error?.code === PERMISSION_DENIED,
        detail: updateResult.error
          ? `Postgres devolvió: ${updateResult.error.message} (code=${updateResult.error.code})`
          : 'La actualización no fue rechazada (no debería haber tenido éxito).',
      });

      let deleteQuery = role.client.from(table).delete();
      for (const [column, value] of Object.entries(seedRowFilter(table))) {
        deleteQuery = deleteQuery.eq(column, value);
      }
      const deleteResult = await deleteQuery;
      results.push({
        label: `RLS: ${role.label} no puede borrar en "${table}"`,
        passed: deleteResult.error?.code === PERMISSION_DENIED,
        detail: deleteResult.error
          ? `Postgres devolvió: ${deleteResult.error.message} (code=${deleteResult.error.code})`
          : 'El borrado no fue rechazado (no debería haber tenido éxito).',
      });
    }

    // Contraparte: service_role sí debe poder leer cada tabla sin error.
    // No es un chequeo redundante con constraints/lease-checks: acá se
    // demuestra explícitamente que el acceso privilegiado sigue disponible
    // después de revocar los GRANT de anon/authenticated.
    const adminRead = await adminClient.from(table).select('*').limit(1);
    results.push({
      label: `RLS: service_role sí puede leer "${table}"`,
      passed: !adminRead.error,
      detail: adminRead.error
        ? `Error inesperado: ${adminRead.error.message}`
        : `Filas devueltas: ${adminRead.data?.length ?? 0}`,
    });
  }

  return results;
}
