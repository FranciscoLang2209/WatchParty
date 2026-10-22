import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CheckResult } from '../utils/db-checks.js';

const PERMISSION_DENIED = '42501';
// Partidos sembrados por supabase/seed.sql (WAT-103).
const MATCH_1 = 'a1111111-1111-1111-1111-111111111111';
const MATCH_2 = 'a2222222-2222-2222-2222-222222222222';
const MATCH_3 = 'a3333333-3333-3333-3333-333333333333';

// Marzo de 2020 en Argentina (UTC-3): lejos de cualquier dato local real, así
// el cálculo conocido no se contamina con filas de desarrollo.
const CUTOFF = '2020-03-15T12:00:00-03:00';
const EMPTY_MONTH_CUTOFF = '2019-01-15T12:00:00-03:00';
const FUTURE_CUTOFF = '2999-01-01T00:00:00Z';

// Rol que hace de reporter en los checks de permisos (ver más abajo).
const REPORTER_STAND_IN = 'authenticated';

interface Aggregate {
  value: number | null;
  omission_reason: string | null;
}

async function rate(client: pg.Client, cutoff: string): Promise<Aggregate> {
  const { rows } = await client.query<Aggregate>(
    'select value, omission_reason from reporting.rated_match_rate($1::timestamptz)',
    [cutoff],
  );
  return rows[0]!;
}

function describe(aggregate: Aggregate): string {
  return `value=${aggregate.value}, omission_reason=${aggregate.omission_reason}`;
}

/** Ejecuta `sql` en un savepoint y devuelve el código de error, o null si no falló. */
async function errorCodeOf(client: pg.Client, sql: string): Promise<string | null> {
  await client.query('savepoint attempt');
  try {
    await client.query(sql);
    await client.query('release savepoint attempt');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return (error as { code?: string }).code ?? 'unknown';
  }
}

async function seedUser(client: pg.Client): Promise<string> {
  const id = randomUUID();
  await client.query('insert into auth.users (id) values ($1)', [id]);
  return id;
}

async function roomOf(client: pg.Client, matchId: string): Promise<string> {
  await client.query('insert into rooms (match_id) values ($1) on conflict (match_id) do nothing', [
    matchId,
  ]);
  const { rows } = await client.query<{ id: string }>('select id from rooms where match_id = $1', [
    matchId,
  ]);
  return rows[0]!.id;
}

async function watch(client: pg.Client, userId: string, matchId: string, at: string) {
  await client.query(
    'insert into watched_matches (user_id, match_id, created_at) values ($1, $2, $3)',
    [userId, matchId, at],
  );
}

async function comment(client: pg.Client, userId: string, matchId: string, at: string) {
  await client.query(
    `insert into room_comments (room_id, author_id, body, client_request_id, created_at)
     values ($1, $2, 'comentario de prueba', gen_random_uuid(), $3)`,
    [await roomOf(client, matchId), userId, at],
  );
}

async function rateMatch(
  client: pg.Client,
  userId: string,
  matchId: string,
  createdAt: string,
  updatedAt: string,
) {
  await client.query(
    `insert into match_ratings (user_id, match_id, rating, created_at, updated_at)
     values ($1, $2, 4, $3, $4)`,
    [userId, matchId, createdAt, updatedAt],
  );
}

/**
 * Verifica el agregado `reporting.rated_match_rate` (WAT-220) con un conjunto
 * conocido. Todo corre dentro de una transacción que el llamador revierte:
 * no deja usuarios, filas ni roles en la base.
 */
export async function checkRatedMatchRate(client: pg.Client): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const empty = await rate(client, EMPTY_MONTH_CUTOFF);
  results.push({
    label: 'Sin pares vistos en el mes: value null con motivo "no-denominator", nunca cero',
    passed: empty.value === null && empty.omission_reason === 'no-denominator',
    detail: describe(empty),
  });

  const future = await rate(client, FUTURE_CUTOFF);
  results.push({
    label: 'Corte T futuro: value null con motivo "invalid-cutoff"',
    passed: future.value === null && future.omission_reason === 'invalid-cutoff',
    detail: describe(future),
  });

  const u1 = await seedUser(client);
  const u2 = await seedUser(client);
  const u3 = await seedUser(client);
  const technical = await seedUser(client);

  // Pares del denominador (vistos en [01/03 00:00, T]):
  // u1–m1: dos comentarios y una nota en el mes → cuenta una sola vez.
  await watch(client, u1, MATCH_1, '2020-03-05T10:00:00-03:00');
  await comment(client, u1, MATCH_1, '2020-03-06T10:00:00-03:00');
  await comment(client, u1, MATCH_1, '2020-03-06T11:00:00-03:00');
  await rateMatch(client, u1, MATCH_1, '2020-03-06T12:00:00-03:00', '2020-03-06T12:00:00-03:00');
  // u1–m2: sin interacción → no calificado.
  await watch(client, u1, MATCH_2, '2020-03-07T10:00:00-03:00');
  // u2–m1: nota creada en febrero pero editada en el mes → calificado.
  await watch(client, u2, MATCH_1, '2020-03-10T10:00:00-03:00');
  await rateMatch(client, u2, MATCH_1, '2020-02-20T10:00:00-03:00', '2020-03-11T10:00:00-03:00');
  // u2–m3: comentario posterior a T → no calificado.
  await watch(client, u2, MATCH_3, '2020-03-10T10:00:00-03:00');
  await comment(client, u2, MATCH_3, '2020-03-15T13:00:00-03:00');
  // u3–m2: visto 00:30 del 1/03 en Argentina (03:30 UTC); comentario del
  // 29/02 23:30 de Argentina, que en UTC ya es 1/03 → no calificado.
  await watch(client, u3, MATCH_2, '2020-03-01T00:30:00-03:00');
  await comment(client, u3, MATCH_2, '2020-02-29T23:30:00-03:00');

  // Fuera del denominador:
  // u3–m3: visto antes del inicio del mes argentino, aunque comentó en el mes.
  await watch(client, u3, MATCH_3, '2020-02-29T23:59:00-03:00');
  await comment(client, u3, MATCH_3, '2020-03-05T10:00:00-03:00');
  // u3–m1: visto un segundo después de T.
  await watch(client, u3, MATCH_1, '2020-03-15T12:00:01-03:00');
  // u1 comentó m3 en el mes sin haberlo visto: no es un par visto.
  await comment(client, u1, MATCH_3, '2020-03-08T10:00:00-03:00');
  // Cuenta técnica con un par visto y comentado en el mes.
  await watch(client, technical, MATCH_1, '2020-03-05T10:00:00-03:00');
  await comment(client, technical, MATCH_1, '2020-03-05T11:00:00-03:00');

  // Sin marcar la cuenta técnica: 3 calificados de 6 vistos.
  const unmarked = await rate(client, CUTOFF);
  results.push({
    label: 'Sin marcar la cuenta técnica, su par cuenta (3/6 = 50 %)',
    passed: unmarked.value === 50 && unmarked.omission_reason === null,
    detail: describe(unmarked),
  });

  await client.query('insert into reporting.technical_accounts (user_id) values ($1)', [technical]);

  // Cálculo conocido: u1–m1 y u2–m1 sobre 5 pares = 40 %.
  const known = await rate(client, CUTOFF);
  results.push({
    label:
      'Cálculo conocido: límites del mes argentino y de T, duplicados y cuenta técnica excluida (2/5 = 40 %)',
    passed: known.value === 40 && known.omission_reason === null,
    detail: describe(known),
  });

  for (const role of ['anon', 'authenticated']) {
    const { rows } = await client.query<{ can_execute: boolean; can_read: boolean }>(
      `select
         has_function_privilege($1, 'reporting.rated_match_rate(timestamptz)', 'execute') as can_execute,
         has_table_privilege($1, 'reporting.technical_accounts', 'select') as can_read`,
      [role],
    );
    results.push({
      label: `Permisos: ${role} no puede ejecutar el agregado ni leer technical_accounts`,
      passed: rows[0]!.can_execute === false && rows[0]!.can_read === false,
      detail: `execute=${rows[0]!.can_execute}, select technical_accounts=${rows[0]!.can_read}`,
    });
  }

  // Simula al rol del reporter dentro de la transacción: le da a
  // authenticated solo USAGE y EXECUTE, y el rollback lo deshace. No crea un
  // rol propio porque en el Postgres de Supabase local `grant <rol> to
  // current_user` tira abajo el proceso (segfault).
  await client.query(`grant usage on schema reporting to ${REPORTER_STAND_IN}`);
  await client.query(
    `grant execute on function reporting.rated_match_rate(timestamptz) to ${REPORTER_STAND_IN}`,
  );
  await client.query(`set local role ${REPORTER_STAND_IN}`);

  const asReporter = await rate(client, CUTOFF);
  results.push({
    label: 'Un rol con solo USAGE y EXECUTE obtiene el agregado',
    passed: asReporter.value === 40,
    detail: describe(asReporter),
  });

  for (const table of [
    'public.watched_matches',
    'public.match_ratings',
    'public.room_comments',
    'reporting.technical_accounts',
  ]) {
    const code = await errorCodeOf(client, `select * from ${table} limit 1`);
    results.push({
      label: `Ese rol no puede leer filas de ${table}`,
      passed: code === PERMISSION_DENIED,
      detail: code ? `code=${code}` : 'La lectura no fue rechazada.',
    });
  }

  await client.query('reset role');

  return results;
}
