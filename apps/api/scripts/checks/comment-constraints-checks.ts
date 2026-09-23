import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';

const NONEXISTENT_ROOM_ID = '99999999-9999-9999-9999-999999999999';
const NONEXISTENT_AUTHOR_ID = '88888888-8888-8888-8888-888888888888';
// Partido sembrado por supabase/seed.sql (WAT-103) — se reutiliza para no
// depender de un módulo `rooms` en Node (WAT-146 todavía no está mergeado):
// la sala de prueba se crea directo por SQL contra ese partido, igual de
// válida para probar los constraints de `room_comments`.
const SEEDED_MATCH_ID = 'a1111111-1111-1111-1111-111111111111';

function validCommentPayload(
  roomId: string,
  authorId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    room_id: roomId,
    author_id: authorId,
    body: 'Comentario de prueba',
    client_request_id: crypto.randomUUID(),
    ...overrides,
  };
}

/**
 * Sala de prueba reutilizable entre corridas: si ya existe (porque el
 * script corrió antes sin un `db reset --local` de por medio), la
 * reutiliza en vez de chocar contra `rooms_match_id_key`.
 */
async function getOrCreateTestRoom(adminClient: SupabaseClient): Promise<string> {
  const { data: existing } = await adminClient
    .from('rooms')
    .select('id')
    .eq('match_id', SEEDED_MATCH_ID)
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  const { data, error } = await adminClient
    .from('rooms')
    .insert({ match_id: SEEDED_MATCH_ID })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`No se pudo crear la sala de prueba: ${error?.message ?? 'sin datos'}`);
  }

  return (data as { id: string }).id;
}

/**
 * Verifica que sea la base de datos, no la aplicación, la que rechace un
 * comentario inválido (WAT-147) — mismo criterio que
 * profile-constraints-checks.ts. Usa service_role porque acá interesa
 * aislar el comportamiento de los constraints de `room_comments`, no el de
 * RLS (esa tabla no tiene políticas abiertas, igual que `rooms`/`profiles`,
 * pero eso no es lo que este chequeo puntual verifica).
 */
export async function checkCommentConstraints(adminClient: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const roomId = await getOrCreateTestRoom(adminClient);
  const authorId = await createTempUserId(adminClient);

  // FK room_comments_room_id_fkey: room_id debe existir en rooms.
  const missingRoomResult = await adminClient
    .from('room_comments')
    .insert(validCommentPayload(NONEXISTENT_ROOM_ID, authorId));

  results.push({
    label: 'FK room_comments_room_id_fkey rechaza room_id inexistente',
    passed: missingRoomResult.error?.code === '23503',
    detail: missingRoomResult.error
      ? `Postgres devolvió: ${missingRoomResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // FK room_comments_author_id_fkey: author_id debe existir en auth.users.
  const missingAuthorResult = await adminClient
    .from('room_comments')
    .insert(validCommentPayload(roomId, NONEXISTENT_AUTHOR_ID));

  results.push({
    label: 'FK room_comments_author_id_fkey rechaza author_id inexistente',
    passed: missingAuthorResult.error?.code === '23503',
    detail: missingAuthorResult.error
      ? `Postgres devolvió: ${missingAuthorResult.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // UNIQUE room_comments_author_client_request_id_key: mismo autor + mismo
  // client_request_id no puede insertarse dos veces (idempotencia real,
  // no simulada por un doble de Supabase como en el test de vitest).
  const sharedClientRequestId = crypto.randomUUID();

  const firstInsert = await adminClient
    .from('room_comments')
    .insert(validCommentPayload(roomId, authorId, { client_request_id: sharedClientRequestId }));

  results.push({
    label: 'El primer insert con un client_request_id nuevo se acepta',
    passed: !firstInsert.error,
    detail: firstInsert.error
      ? `Error inesperado: ${firstInsert.error.message}`
      : 'Insertado sin error.',
  });

  const duplicateInsert = await adminClient
    .from('room_comments')
    .insert(validCommentPayload(roomId, authorId, { client_request_id: sharedClientRequestId }));

  results.push({
    label:
      'UNIQUE room_comments_author_client_request_id_key rechaza un reintento con el mismo (author_id, client_request_id)',
    passed: duplicateInsert.error?.code === '23505',
    detail: duplicateInsert.error
      ? `Postgres devolvió: ${duplicateInsert.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // Contraparte: un comentario válido con datos nuevos se acepta.
  const validResult = await adminClient
    .from('room_comments')
    .insert(validCommentPayload(roomId, authorId));

  results.push({
    label: 'Un comentario válido con room_id/author_id existentes se acepta',
    passed: !validResult.error,
    detail: validResult.error
      ? `Error inesperado: ${validResult.error.message}`
      : 'Insertado sin error.',
  });

  return results;
}
