import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { createTempUserId } from '../utils/supabase-clients.js';
import { getOrCreateTestRoom } from '../utils/room-fixture.js';

const NONEXISTENT_COMMENT_ID = '77777777-7777-7777-7777-777777777777';
const NONEXISTENT_USER_ID = '66666666-6666-6666-6666-666666666666';
const PERMISSION_DENIED = '42501';
// Partido sembrado por supabase/seed.sql; misma estrategia que
// comment-constraints-checks.ts para no depender de un módulo `rooms` en Node.

async function createTestComment(
  adminClient: SupabaseClient,
  roomId: string,
  authorId: string,
): Promise<string> {
  const { data, error } = await adminClient
    .from('room_comments')
    .insert({
      room_id: roomId,
      author_id: authorId,
      body: 'Comentario para reaccionar',
      client_request_id: crypto.randomUUID(),
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`No se pudo crear el comentario de prueba: ${error?.message ?? 'sin datos'}`);
  }
  return (data as { id: string }).id;
}

/**
 * Verifica que la base garantice la unicidad y la integridad referencial de
 * `room_comment_reactions` (WAT-165), y que la web no tenga acceso directo.
 * Corre contra Supabase local real: los dobles de vitest no pueden demostrar
 * un UNIQUE ni un FK.
 */
export async function checkCommentReactions(
  adminClient: SupabaseClient,
  anonClient: SupabaseClient,
  authenticatedClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const roomId = await getOrCreateTestRoom(adminClient);
  const authorId = await createTempUserId(adminClient);
  const userA = await createTempUserId(adminClient);
  const userB = await createTempUserId(adminClient);
  const commentId = await createTestComment(adminClient, roomId, authorId);

  // FKs
  const missingComment = await adminClient
    .from('room_comment_reactions')
    .insert({ comment_id: NONEXISTENT_COMMENT_ID, user_id: userA });
  results.push({
    label: 'FK rechaza comment_id inexistente',
    passed: missingComment.error?.code === '23503',
    detail: missingComment.error
      ? `Postgres devolvió: ${missingComment.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  const missingUser = await adminClient
    .from('room_comment_reactions')
    .insert({ comment_id: commentId, user_id: NONEXISTENT_USER_ID });
  results.push({
    label: 'FK rechaza user_id inexistente',
    passed: missingUser.error?.code === '23503',
    detail: missingUser.error
      ? `Postgres devolvió: ${missingUser.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  // UNIQUE
  const first = await adminClient
    .from('room_comment_reactions')
    .insert({ comment_id: commentId, user_id: userA });
  results.push({
    label: 'La primera reacción de un usuario a un comentario se acepta',
    passed: !first.error,
    detail: first.error ? `Error inesperado: ${first.error.message}` : 'Insertada sin error.',
  });

  const duplicate = await adminClient
    .from('room_comment_reactions')
    .insert({ comment_id: commentId, user_id: userA });
  results.push({
    label: 'UNIQUE rechaza una segunda reacción del mismo (user_id, comment_id)',
    passed: duplicate.error?.code === '23505',
    detail: duplicate.error
      ? `Postgres devolvió: ${duplicate.error.message}`
      : 'La inserción no fue rechazada (no debería haber tenido éxito).',
  });

  const otherUser = await adminClient
    .from('room_comment_reactions')
    .insert({ comment_id: commentId, user_id: userB });
  results.push({
    label: 'Dos usuarios distintos pueden reaccionar al mismo comentario',
    passed: !otherUser.error,
    detail: otherUser.error
      ? `Error inesperado: ${otherUser.error.message}`
      : 'Insertada sin error.',
  });

  // Concurrencia: N inserts simultáneos del mismo par -> exactamente 1 gana.
  const concurrentUser = await createTempUserId(adminClient);
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      adminClient
        .from('room_comment_reactions')
        .insert({ comment_id: commentId, user_id: concurrentUser }),
    ),
  );
  const winners = attempts.filter((a) => !a.error).length;
  results.push({
    label: 'Inserts concurrentes del mismo (user_id, comment_id): exactamente uno se acepta',
    passed: winners === 1,
    detail: `Aceptados: ${winners} de ${attempts.length}.`,
  });

  // ON DELETE CASCADE
  const disposableComment = await createTestComment(adminClient, roomId, authorId);
  await adminClient
    .from('room_comment_reactions')
    .insert({ comment_id: disposableComment, user_id: userA });
  const deleteComment = await adminClient
    .from('room_comments')
    .delete()
    .eq('id', disposableComment);
  const remaining = await adminClient
    .from('room_comment_reactions')
    .select('id')
    .eq('comment_id', disposableComment);
  results.push({
    label: 'Borrar un comentario elimina sus reacciones (ON DELETE CASCADE)',
    passed: !deleteComment.error && !remaining.error && (remaining.data?.length ?? -1) === 0,
    detail: deleteComment.error
      ? `Error al borrar: ${deleteComment.error.message}`
      : `Reacciones restantes: ${remaining.data?.length ?? 'desconocido'}`,
  });

  // RLS + grants
  const roles: Array<{ label: string; client: SupabaseClient }> = [
    { label: 'anon', client: anonClient },
    { label: 'un usuario autenticado', client: authenticatedClient },
  ];
  for (const role of roles) {
    const read = await role.client.from('room_comment_reactions').select('*');
    results.push({
      label: `RLS: ${role.label} no puede leer "room_comment_reactions"`,
      passed: read.error?.code === PERMISSION_DENIED,
      detail: read.error
        ? `Postgres devolvió: ${read.error.message} (code=${read.error.code})`
        : `La lectura no fue rechazada (devolvió ${read.data?.length ?? 0} filas).`,
    });

    const insert = await role.client
      .from('room_comment_reactions')
      .insert({ comment_id: commentId, user_id: await createTempUserId(adminClient) });
    results.push({
      label: `RLS: ${role.label} no puede insertar en "room_comment_reactions"`,
      passed: insert.error?.code === PERMISSION_DENIED,
      detail: insert.error
        ? `Postgres devolvió: ${insert.error.message} (code=${insert.error.code})`
        : 'La inserción no fue rechazada (no debería haber tenido éxito).',
    });

    const del = await role.client
      .from('room_comment_reactions')
      .delete()
      .eq('comment_id', commentId);
    results.push({
      label: `RLS: ${role.label} no puede borrar en "room_comment_reactions"`,
      passed: del.error?.code === PERMISSION_DENIED,
      detail: del.error
        ? `Postgres devolvió: ${del.error.message} (code=${del.error.code})`
        : 'El borrado no fue rechazado (no debería haber tenido éxito).',
    });
  }

  return results;
}
