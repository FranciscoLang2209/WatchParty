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
  react,
  seedUser,
  watch,
  type Aggregate,
} from '../utils/reporting-fixtures.js';

const PERMISSION_DENIED = '42501';

// Marzo de 2020 en Argentina (UTC-3): lejos de cualquier dato local real, así
// el cálculo conocido no se contamina con filas de desarrollo. Junio de 2018
// solo tiene vistos; enero de 2019 no tiene actividad.
const CUTOFF = '2020-03-15T12:00:00-03:00';
const ONLY_WATCHED_CUTOFF = '2018-06-15T12:00:00-03:00';
const EMPTY_MONTH_CUTOFF = '2019-01-15T12:00:00-03:00';
const FUTURE_CUTOFF = '2999-01-01T00:00:00Z';

// Rol que hace de reporter en los checks de permisos (ver
// rated-match-rate-checks.ts).
const REPORTER_STAND_IN = 'authenticated';

async function average(client: pg.Client, cutoff: string): Promise<Aggregate> {
  const { rows } = await client.query<Aggregate>(
    'select value, omission_reason from reporting.monthly_interactions_avg($1::timestamptz)',
    [cutoff],
  );
  return rows[0]!;
}

function isClose(value: number | null, expected: number): boolean {
  return value !== null && Math.abs(value - expected) < 1e-9;
}

/**
 * Verifica el agregado `reporting.monthly_interactions_avg` (WAT-221) con un
 * conjunto conocido. Todo corre dentro de una transacción que el llamador
 * revierte: no deja usuarios ni filas en la base.
 */
export async function checkMonthlyInteractionsAvg(client: pg.Client): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const empty = await average(client, EMPTY_MONTH_CUTOFF);
  results.push({
    label: 'Sin usuarios activos en el mes: value null con motivo "no-denominator", nunca cero',
    passed: empty.value === null && empty.omission_reason === 'no-denominator',
    detail: describe(empty),
  });

  const future = await average(client, FUTURE_CUTOFF);
  results.push({
    label: 'Corte T futuro: value null con motivo "invalid-cutoff"',
    passed: future.value === null && future.omission_reason === 'invalid-cutoff',
    detail: describe(future),
  });

  // Un mes con un único usuario que solo marcó un visto: activo, cero
  // interacciones → 0 válido, no una omisión.
  const watcher = await seedUser(client);
  await watch(client, watcher, MATCH_1, '2018-06-10T10:00:00-03:00');
  const onlyWatched = await average(client, ONLY_WATCHED_CUTOFF);
  results.push({
    label: 'Usuario activo solo por visto: cuenta en el denominador y el promedio es 0',
    passed: onlyWatched.value === 0 && onlyWatched.omission_reason === null,
    detail: describe(onlyWatched),
  });

  const u1 = await seedUser(client);
  const u2 = await seedUser(client);
  const u3 = await seedUser(client);
  const u4 = await seedUser(client);
  const technical = await seedUser(client);

  // u1: una nota y dos comentarios en el mes → 3 interacciones.
  await watch(client, u1, MATCH_1, '2020-03-05T10:00:00-03:00');
  await rateMatch(client, u1, MATCH_1, '2020-03-06T12:00:00-03:00', '2020-03-06T12:00:00-03:00');
  const u1Comment = await comment(client, u1, MATCH_1, '2020-03-06T10:00:00-03:00');
  await comment(client, u1, MATCH_1, '2020-03-06T11:00:00-03:00');
  // u2: solo vistos en el mes, y una reacción → activo, 0 interacciones.
  await watch(client, u2, MATCH_2, '2020-03-07T10:00:00-03:00');
  await watch(client, u2, MATCH_3, '2020-03-08T10:00:00-03:00');
  await react(client, u2, u1Comment, '2020-03-07T11:00:00-03:00');
  // u3: nota creada en febrero y editada en el mes (no es un registro nuevo);
  // comentario de las 00:30 del 1/03 en Argentina (dentro); comentario del
  // 29/02 23:30 de Argentina, que en UTC ya es 1/03 (fuera) → 1 interacción.
  await rateMatch(client, u3, MATCH_2, '2020-02-20T10:00:00-03:00', '2020-03-11T10:00:00-03:00');
  await comment(client, u3, MATCH_2, '2020-03-01T00:30:00-03:00');
  await comment(client, u3, MATCH_3, '2020-02-29T23:30:00-03:00');
  // u4: todo un segundo después de T → no es activo.
  await watch(client, u4, MATCH_1, '2020-03-15T12:00:01-03:00');
  await comment(client, u4, MATCH_1, '2020-03-15T12:00:01-03:00');
  // Cuenta técnica: un visto y un comentario en el mes.
  await watch(client, technical, MATCH_1, '2020-03-05T10:00:00-03:00');
  await comment(client, technical, MATCH_1, '2020-03-05T11:00:00-03:00');

  // Sin marcar la cuenta técnica: 5 interacciones / 4 usuarios.
  const unmarked = await average(client, CUTOFF);
  results.push({
    label: 'Sin marcar la cuenta técnica, cuenta en ambos lados (5/4 = 1.25)',
    passed: isClose(unmarked.value, 1.25) && unmarked.omission_reason === null,
    detail: describe(unmarked),
  });

  await markTechnical(client, technical);

  // Cálculo conocido: (3 + 0 + 1) / 3 usuarios activos.
  const known = await average(client, CUTOFF);
  results.push({
    label:
      'Cálculo conocido: límites del mes argentino y de T, edición y reacción no suman, cuenta técnica excluida (4/3)',
    passed: isClose(known.value, 4 / 3) && known.omission_reason === null,
    detail: describe(known),
  });

  for (const role of ['anon', 'authenticated']) {
    const { rows } = await client.query<{ can_execute: boolean }>(
      `select has_function_privilege($1, 'reporting.monthly_interactions_avg(timestamptz)', 'execute')
         as can_execute`,
      [role],
    );
    results.push({
      label: `Permisos: ${role} no puede ejecutar el agregado`,
      passed: rows[0]!.can_execute === false,
      detail: `execute=${rows[0]!.can_execute}`,
    });
  }

  await actAsReporter(client, REPORTER_STAND_IN, 'reporting.monthly_interactions_avg(timestamptz)');

  const asReporter = await average(client, CUTOFF);
  results.push({
    label: 'Un rol con solo USAGE y EXECUTE obtiene el agregado',
    passed: isClose(asReporter.value, 4 / 3),
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
