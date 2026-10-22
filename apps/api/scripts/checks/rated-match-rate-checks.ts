import type pg from 'pg';
import type { CheckResult } from '../utils/db-checks.js';
import {
  MATCH_1,
  MATCH_2,
  MATCH_3,
  actAsReporter,
  comment,
  describe,
  errorCodeOf,
  markTechnical,
  rateMatch,
  seedUser,
  watch,
  type Aggregate,
} from '../utils/reporting-fixtures.js';

const PERMISSION_DENIED = '42501';

// Marzo de 2020 en Argentina (UTC-3): lejos de cualquier dato local real, así
// el cálculo conocido no se contamina con filas de desarrollo.
const CUTOFF = '2020-03-15T12:00:00-03:00';
const EMPTY_MONTH_CUTOFF = '2019-01-15T12:00:00-03:00';
const FUTURE_CUTOFF = '2999-01-01T00:00:00Z';

// Rol que hace de reporter en los checks de permisos (ver más abajo).
const REPORTER_STAND_IN = 'authenticated';

async function rate(client: pg.Client, cutoff: string): Promise<Aggregate> {
  const { rows } = await client.query<Aggregate>(
    'select value, omission_reason from reporting.rated_match_rate($1::timestamptz)',
    [cutoff],
  );
  return rows[0]!;
}

/**
 * Verifica el agregado `reporting.rated_match_rate` (WAT-220) con un conjunto
 * conocido. Todo corre dentro de una transacción que el llamador revierte:
 * no deja usuarios, filas ni roles en la base.
 */
export async function checkRatedMatchRate(client: pg.Client): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Mismo escenario que producción: el esquema es de otro rol y postgres solo
  // crea ahí porque ese dueño se lo permite.
  const { rows: schema } = await client.query<{ owner: string; postgres_create: boolean }>(
    `select pg_get_userbyid(nspowner) as owner,
            has_schema_privilege('postgres', 'reporting', 'CREATE') as postgres_create
     from pg_namespace where nspname = 'reporting'`,
  );
  results.push({
    label: 'El esquema reporting es de watchparty_reporter_source, como en producción',
    passed: schema[0]?.owner === 'watchparty_reporter_source' && schema[0].postgres_create,
    detail: `dueño=${schema[0]?.owner}, postgres CREATE=${schema[0]?.postgres_create}`,
  });

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

  await markTechnical(client, technical);

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
  await actAsReporter(client, REPORTER_STAND_IN, 'reporting.rated_match_rate(timestamptz)');

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
