import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const PERMISSION_DENIED = '42501';

/** Payload válido para un INSERT de prueba: no viola ningún constraint de WAT-124. */
function validProfilePayload(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    display_name: 'Hincha de prueba',
    bio: '',
    favorite_team_id: null,
    ...overrides,
  };
}

/**
 * Verifica que ni un visitante anónimo ni un usuario autenticado común
 * puedan leer ni escribir profiles de forma directa — mismo criterio que
 * rls-checks.ts aplica a teams/matches/provider_sync_state. El único
 * acceso privilegiado es vía service_role, que en este proyecto solo usa
 * el backend a través del cliente servidor que entrega WAT-106.
 *
 * El perfil contra el que se prueba pertenece a un tercer usuario, distinto
 * del que hay detrás de authenticatedClient: así el rechazo de UPDATE/DELETE
 * para "un usuario autenticado" ya demuestra que tampoco puede tocar el
 * perfil de otro, sin necesitar un caso aparte. Nota: WAT-126 (el endpoint
 * real) todavía no existe — lo que se prueba acá es la garantía de base
 * (ningún camino directo a PostgREST escribe sobre profiles salvo
 * service_role), no el comportamiento final de la API.
 */
export async function checkProfileRls(
  anonClient: SupabaseClient,
  authenticatedClient: SupabaseClient,
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const ownerId = await createTempUserId(adminClient);
  const seeded = await adminClient.from('profiles').insert(validProfilePayload(ownerId));

  if (seeded.error) {
    throw new Error(`No se pudo sembrar un perfil de prueba: ${seeded.error.message}`);
  }

  const roles: Array<{ label: string; client: SupabaseClient }> = [
    { label: 'anon', client: anonClient },
    { label: 'un usuario autenticado (de otro perfil)', client: authenticatedClient },
  ];

  for (const role of roles) {
    const read = await role.client.from('profiles').select('*');
    results.push({
      label: `RLS: ${role.label} no puede leer "profiles"`,
      passed: read.error?.code === PERMISSION_DENIED,
      detail: read.error
        ? `Postgres devolvió: ${read.error.message} (code=${read.error.code})`
        : `La lectura no fue rechazada (devolvió ${read.data?.length ?? 0} filas).`,
    });

    const insert = await role.client
      .from('profiles')
      .insert(validProfilePayload(await createTempUserId(adminClient)));
    results.push({
      label: `RLS: ${role.label} no puede insertar en "profiles"`,
      passed: insert.error?.code === PERMISSION_DENIED,
      detail: insert.error
        ? `Postgres devolvió: ${insert.error.message} (code=${insert.error.code})`
        : 'La inserción no fue rechazada (no debería haber tenido éxito).',
    });

    const update = await role.client
      .from('profiles')
      .update({ display_name: 'Nombre pisado' })
      .eq('user_id', ownerId);
    results.push({
      label: `RLS: ${role.label} no puede actualizar el perfil de otro usuario en "profiles"`,
      passed: update.error?.code === PERMISSION_DENIED,
      detail: update.error
        ? `Postgres devolvió: ${update.error.message} (code=${update.error.code})`
        : 'La actualización no fue rechazada (no debería haber tenido éxito).',
    });

    const del = await role.client.from('profiles').delete().eq('user_id', ownerId);
    results.push({
      label: `RLS: ${role.label} no puede borrar el perfil de otro usuario en "profiles"`,
      passed: del.error?.code === PERMISSION_DENIED,
      detail: del.error
        ? `Postgres devolvió: ${del.error.message} (code=${del.error.code})`
        : 'El borrado no fue rechazado (no debería haber tenido éxito).',
    });
  }

  const adminRead = await adminClient.from('profiles').select('*').limit(1);
  results.push({
    label: 'RLS: service_role sí puede leer "profiles"',
    passed: !adminRead.error,
    detail: adminRead.error
      ? `Error inesperado: ${adminRead.error.message}`
      : `Filas devueltas: ${adminRead.data?.length ?? 0}`,
  });

  return results;
}
