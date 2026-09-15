import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const NONEXISTENT_TEAM_ID = '99999999-9999-9999-9999-999999999999';

/** Payload base de un perfil válido, para variar un solo campo por test. */
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
 * Verifica que sea la base de datos, no la aplicación, la que rechace un
 * perfil inválido. Usa service_role porque acá interesa aislar el
 * comportamiento de los constraints, no el de RLS/permisos (eso va en
 * profile-rls-checks.ts, WAT-125). Cada intento usa un user_id nuevo, para
 * que el único campo bajo prueba sea el que falla — mismo criterio que
 * constraints-checks.ts para teams/matches.
 */
export async function checkProfileConstraints(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // CHECK profiles_display_name_length: vacío tras trim se rechaza.
  const blankNameResult = await adminClient
    .from('profiles')
    .insert(validProfilePayload(await createTempUserId(adminClient), { display_name: '   ' }));

  results.push({
    label: 'CHECK profiles_display_name_length rechaza display_name vacío tras trim',
    passed: blankNameResult.error?.code === '23514',
    detail: blankNameResult.error
      ? `Postgres devolvió: ${blankNameResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // CHECK profiles_display_name_length: más de 50 caracteres se rechaza.
  const longNameResult = await adminClient
    .from('profiles')
    .insert(
      validProfilePayload(await createTempUserId(adminClient), { display_name: 'A'.repeat(51) }),
    );

  results.push({
    label: 'CHECK profiles_display_name_length rechaza display_name de más de 50 caracteres',
    passed: longNameResult.error?.code === '23514',
    detail: longNameResult.error
      ? `Postgres devolvió: ${longNameResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // CHECK profiles_bio_length: más de 280 caracteres se rechaza.
  const longBioResult = await adminClient
    .from('profiles')
    .insert(validProfilePayload(await createTempUserId(adminClient), { bio: 'B'.repeat(281) }));

  results.push({
    label: 'CHECK profiles_bio_length rechaza bio de más de 280 caracteres',
    passed: longBioResult.error?.code === '23514',
    detail: longBioResult.error
      ? `Postgres devolvió: ${longBioResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // FK profiles_favorite_team_id_fkey: favorite_team_id debe existir en teams.
  const missingTeamResult = await adminClient.from('profiles').insert(
    validProfilePayload(await createTempUserId(adminClient), {
      favorite_team_id: NONEXISTENT_TEAM_ID,
    }),
  );

  results.push({
    label: 'FK profiles_favorite_team_id_fkey rechaza favorite_team_id inexistente',
    passed: missingTeamResult.error?.code === '23503',
    detail: missingTeamResult.error
      ? `Postgres devolvió: ${missingTeamResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // Contraparte: un perfil válido con favorite_team_id null se acepta.
  const validResult = await adminClient
    .from('profiles')
    .insert(validProfilePayload(await createTempUserId(adminClient)));

  results.push({
    label: 'Un perfil válido con favorite_team_id null se acepta',
    passed: !validResult.error,
    detail: validResult.error
      ? `Error inesperado: ${validResult.error.message}`
      : 'Insertado sin error.',
  });

  return results;
}
