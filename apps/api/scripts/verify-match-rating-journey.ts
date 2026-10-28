import type { SupabaseClient } from '@supabase/supabase-js';
import { createAnonClient, createServiceRoleClient } from './utils/supabase-clients.js';
import { printResults, type CheckResult } from './utils/db-checks.js';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = 'Verify-Rating-Pass-1!';
const FIXTURE_PROVIDER = 'verify-rating-journey';
const DAY_MS = 24 * 60 * 60 * 1000;
const NONEXISTENT_MATCH_ID = '99999999-9999-4999-8999-999999999999';

type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';

interface Session {
  userId: string;
  email: string;
  token: string;
}

interface ApiResponse {
  status: number;
  body: unknown;
}

interface Fixture {
  teamIds: string[];
  matchIds: string[];
  finishedA: string;
  finishedB: string;
  finishedUnwatched: string;
  ineligible: { status: MatchStatus; id: string }[];
}

/**
 * Corta antes de crear nada si el Supabase configurado no es el local: este
 * recorrido crea y borra usuarios, partidos y notas. Nunca debe correr contra
 * producción (ver docs/runbooks/production-migrations.md).
 */
function assertLocalSupabase(): void {
  const raw = process.env.SUPABASE_URL ?? '';
  let hostname = '';
  try {
    hostname = new URL(raw).hostname;
  } catch {
    // Se informa abajo con el mismo mensaje.
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(
      'Este recorrido solo corre contra el Supabase local (SUPABASE_URL debe apuntar a 127.0.0.1 o localhost).',
    );
  }
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function signUp(prefix: string): Promise<Session> {
  const email = `${prefix}-${uniqueSuffix()}@watchparty.local`;
  const { data, error } = await createAnonClient().auth.signUp({ email, password: PASSWORD });
  if (error || !data.session || !data.user) {
    throw new Error(`No se pudo crear el usuario temporal: ${error?.message ?? 'sin sesión'}`);
  }
  return { userId: data.user.id, email, token: data.session.access_token };
}

/** Inicia una sesión NUEVA del mismo usuario: otro token, mismo user_id. */
async function signIn(email: string): Promise<string> {
  const { data, error } = await createAnonClient().auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`No se pudo iniciar sesión: ${error?.message ?? 'sin sesión'}`);
  }
  return data.session.access_token;
}

async function api(
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  options: { token?: string; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.rawBody !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: options.rawBody,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function putRating(
  token: string,
  matchId: string,
  body: unknown,
  extra: { headers?: Record<string, string>; query?: string } = {},
): Promise<ApiResponse> {
  return api('PUT', `/matches/${matchId}/rating${extra.query ?? ''}`, {
    token,
    rawBody: JSON.stringify(body),
    headers: extra.headers,
  });
}

function getRating(token: string, matchId: string, query = ''): Promise<ApiResponse> {
  return api('GET', `/matches/${matchId}/rating${query}`, { token });
}

function getSummary(token: string, matchId: string): Promise<ApiResponse> {
  return api('GET', `/matches/${matchId}/rating-summary`, { token });
}

async function setWatched(token: string, matchId: string): Promise<void> {
  const response = await api('PUT', `/matches/${matchId}/watched`, { token });
  if (response.status !== 200) {
    throw new Error(`No se pudo marcar el partido como visto (${response.status}).`);
  }
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function insertOrFail<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error || !data) {
    throw new Error(`No se pudo ${label}: ${error?.message ?? 'sin datos'}`);
  }
  return data;
}

/**
 * Partidos propios del recorrido, con service_role (como el backend): uno por
 * estado, así no depende del seed ni de la fecha del último `db reset`.
 */
async function createFixture(admin: SupabaseClient): Promise<Fixture> {
  const run = uniqueSuffix();
  const teams = await insertOrFail<{ id: string }>(
    'crear los equipos de prueba',
    admin
      .from('teams')
      .insert([
        { provider: FIXTURE_PROVIDER, external_id: `${run}-home`, name: 'Verify Local' },
        { provider: FIXTURE_PROVIDER, external_id: `${run}-away`, name: 'Verify Visitante' },
      ])
      .select('id'),
  );
  const [home, away] = teams.map((team) => team.id);

  const statuses: MatchStatus[] = [
    'finished',
    'finished',
    'finished',
    'scheduled',
    'live',
    'postponed',
    'cancelled',
  ];
  const matches = await insertOrFail<{ id: string; external_id: string }>(
    'crear los partidos de prueba',
    admin
      .from('matches')
      .insert(
        statuses.map((status, i) => ({
          provider: FIXTURE_PROVIDER,
          external_id: `${run}-match-${i}`,
          home_team_id: home,
          away_team_id: away,
          competition_external_id: FIXTURE_PROVIDER,
          season: '2026',
          kickoff_at: new Date(
            Date.now() + (status === 'finished' ? -(i + 1) : i) * DAY_MS,
          ).toISOString(),
          status,
        })),
      )
      .select('id, external_id'),
  );
  // Mismo orden con que se crearon (el índice va en external_id).
  matches.sort((x, y) => x.external_id.localeCompare(y.external_id, undefined, { numeric: true }));
  const ids = matches.map((match) => match.id);

  return {
    teamIds: teams.map((team) => team.id),
    matchIds: ids,
    finishedA: ids[0]!,
    finishedB: ids[1]!,
    finishedUnwatched: ids[2]!,
    ineligible: statuses
      .map((status, i) => ({ status, id: ids[i]! }))
      .filter((match) => match.status !== 'finished'),
  };
}

/**
 * Borra lo creado. Las notas y los vistos van primero: sus FK no cascadean.
 * Supabase devuelve los fallos en `error` en vez de lanzar, así que cada paso
 * se comprueba: si uno falla igual se intentan los siguientes y se devuelve
 * la lista de lo que quedó pendiente (vacía si se limpió todo).
 */
async function removeFixture(
  admin: SupabaseClient,
  fixture: Fixture,
  sessions: Session[],
): Promise<string[]> {
  const pending: string[] = [];
  const step = async (
    label: string,
    operation: PromiseLike<{ error: { message: string } | null }>,
  ): Promise<void> => {
    try {
      const { error } = await operation;
      if (error) pending.push(`${label}: ${error.message}`);
    } catch (error) {
      pending.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await step('notas', admin.from('match_ratings').delete().in('match_id', fixture.matchIds));
  await step('vistos', admin.from('watched_matches').delete().in('match_id', fixture.matchIds));
  await step('partidos', admin.from('matches').delete().in('id', fixture.matchIds));
  await step('equipos', admin.from('teams').delete().in('id', fixture.teamIds));
  for (const session of sessions) {
    await step('usuario temporal', admin.auth.admin.deleteUser(session.userId));
  }
  return pending;
}

async function dbRatings(
  admin: SupabaseClient,
  matchId: string,
): Promise<{ user_id: string; rating: number; created_at: string; updated_at: string }[]> {
  const { data, error } = await admin
    .from('match_ratings')
    .select('user_id, rating, created_at, updated_at')
    .eq('match_id', matchId);
  if (error || !data) {
    throw new Error(`No se pudieron leer las notas de la base: ${error?.message ?? 'sin datos'}`);
  }
  return data;
}

/**
 * Recorrido integrado de calificaciones (WAT-216) contra la API y el Supabase
 * locales, con dos usuarios temporales: persistencia, edición, agregado sin
 * votantes duplicados, rechazos del servidor y aislamiento entre usuarios.
 * Crea usuarios y partidos propios y los borra al final. Solo para local.
 */
async function runChecks(
  admin: SupabaseClient,
  fixture: Fixture,
  a: Session,
  b: Session,
): Promise<boolean> {
  const results: CheckResult[] = [];
  const check = (label: string, passed: boolean, detail?: string): void => {
    results.push({ label, passed, detail });
  };
  const { finishedA: match, finishedB: other, finishedUnwatched: unwatched } = fixture;

  // ── (a) Recorrido: visto → calificar → recargar → editar ──────────────────
  await setWatched(a.token, match);
  await setWatched(b.token, match);

  const initial = await getRating(a.token, match);
  check(
    'A: antes de calificar, GET devuelve { rating: null }',
    initial.status === 200 && sameJson(initial.body, { rating: null }),
    `status=${initial.status}`,
  );
  const initialSummary = await getSummary(a.token, match);
  check(
    'Partido sin votos: resumen { average: null, count: 0 }',
    initialSummary.status === 200 && sameJson(initialSummary.body, { average: null, count: 0 }),
    `status=${initialSummary.status}`,
  );

  const saved = await putRating(a.token, match, { rating: 4 });
  check(
    'A: PUT { rating: 4 } responde 200 con la nota guardada',
    saved.status === 200 && sameJson(saved.body, { rating: 4 }),
    `status=${saved.status}`,
  );

  const reloaded = await getRating(a.token, match);
  check(
    'A: al recargar (GET) la nota sigue siendo 4',
    reloaded.status === 200 && sameJson(reloaded.body, { rating: 4 }),
  );

  const aSecondToken = await signIn(a.email);
  const inNewSession = await getRating(aSecondToken, match);
  check(
    'A: en una sesión nueva (otro token) la nota persiste',
    aSecondToken !== a.token &&
      inNewSession.status === 200 &&
      sameJson(inNewSession.body, { rating: 4 }),
  );

  const rowsAfterFirst = await dbRatings(admin, match);
  const firstRow = rowsAfterFirst.find((row) => row.user_id === a.userId);
  check(
    'Base: hay una sola fila de A para el partido, con la nota 4',
    rowsAfterFirst.length === 1 && firstRow?.rating === 4,
    `filas=${rowsAfterFirst.length}`,
  );

  const summaryA = await getSummary(a.token, match);
  check(
    'Resumen tras la nota de A: { average: 4, count: 1 }',
    summaryA.status === 200 && sameJson(summaryA.body, { average: 4, count: 1 }),
  );

  const repeated = await putRating(a.token, match, { rating: 4 });
  const summaryRepeated = await getSummary(a.token, match);
  check(
    'Repetir el mismo PUT no duplica el voto (count sigue en 1)',
    repeated.status === 200 && sameJson(summaryRepeated.body, { average: 4, count: 1 }),
  );

  // B califica el mismo partido: no debe pisar la nota de A.
  const savedB = await putRating(b.token, match, { rating: 2 });
  check(
    'B: PUT { rating: 2 } responde 200',
    savedB.status === 200 && sameJson(savedB.body, { rating: 2 }),
  );
  const summaryAB = await getSummary(b.token, match);
  check(
    'Resumen con dos votantes (4 y 2): { average: 3, count: 2 }',
    summaryAB.status === 200 && sameJson(summaryAB.body, { average: 3, count: 2 }),
  );

  // Edición desde la sesión nueva.
  const edited = await putRating(aSecondToken, match, { rating: 5 });
  check(
    'A: editar la nota a 5 desde la sesión nueva responde 200',
    edited.status === 200 && sameJson(edited.body, { rating: 5 }),
  );
  const seenFromFirstSession = await getRating(a.token, match);
  check(
    'A: la sesión original ve la nota editada (5)',
    sameJson(seenFromFirstSession.body, { rating: 5 }),
  );
  const summaryEdited = await getSummary(a.token, match);
  check(
    'La edición no suma votantes: { average: 3.5, count: 2 }',
    summaryEdited.status === 200 && sameJson(summaryEdited.body, { average: 3.5, count: 2 }),
    `body=${JSON.stringify(summaryEdited.body)}`,
  );

  const rowsAfterEdit = await dbRatings(admin, match);
  const editedRow = rowsAfterEdit.find((row) => row.user_id === a.userId);
  check(
    'Base: tras editar sigue habiendo 2 filas (una por usuario) y created_at no cambió',
    rowsAfterEdit.length === 2 &&
      editedRow?.rating === 5 &&
      editedRow.created_at === firstRow?.created_at &&
      editedRow.updated_at >= (firstRow?.updated_at ?? ''),
    `filas=${rowsAfterEdit.length}`,
  );

  const editedB = await putRating(b.token, match, { rating: 1 });
  const summaryEditedB = await getSummary(b.token, match);
  check(
    'B edita a 1: { average: 3, count: 2 }',
    editedB.status === 200 && sameJson(summaryEditedB.body, { average: 3, count: 2 }),
  );

  const summaryKeys = Object.keys((summaryEditedB.body ?? {}) as object).sort();
  check(
    'El resumen expone solo average y count (sin identidades ni notas individuales)',
    sameJson(summaryKeys, ['average', 'count']),
    `campos=${summaryKeys.join(',')}`,
  );

  // ── (b) Rechazos del servidor ─────────────────────────────────────────────
  const invalidBodies: [string, unknown][] = [
    ['0', { rating: 0 }],
    ['6', { rating: 6 }],
    ['-1', { rating: -1 }],
    ['3.5', { rating: 3.5 }],
    ['"4" (texto)', { rating: '4' }],
    ['null', { rating: null }],
    ['true', { rating: true }],
    ['sin campo rating', {}],
  ];
  for (const [label, body] of invalidBodies) {
    const response = await putRating(a.token, match, body);
    check(`Nota inválida ${label}: 400`, response.status === 400, `status=${response.status}`);
  }
  const malformedJson = await api('PUT', `/matches/${match}/rating`, {
    token: a.token,
    rawBody: '{"rating": ',
  });
  check(
    'Cuerpo que no es JSON válido: 400',
    malformedJson.status === 400,
    `status=${malformedJson.status}`,
  );
  const afterInvalid = await getRating(a.token, match);
  check(
    'Tras los rechazos, la nota de A no cambió (sigue en 5)',
    sameJson(afterInvalid.body, { rating: 5 }),
  );

  for (const { status, id } of fixture.ineligible) {
    // Se inserta el visto con service_role para aislar la regla de la nota
    // de cualquier regla de la ruta de "marcar como visto".
    const { error: watchedError } = await admin
      .from('watched_matches')
      .upsert({ user_id: a.userId, match_id: id });
    if (watchedError) {
      throw new Error(`No se pudo marcar como visto el partido ${status}: ${watchedError.message}`);
    }
    // Precondición: si la API ya lo ve como visto, el 409 de abajo solo puede
    // venir de la regla de estado y no de la de "no visto".
    const watchedRead = await api('GET', `/matches/${id}/watched`, { token: a.token });
    if (watchedRead.status !== 200 || !sameJson(watchedRead.body, { watched: true })) {
      throw new Error(`El partido ${status} no figura como visto para A (${watchedRead.status}).`);
    }
    const response = await putRating(a.token, id, { rating: 3 });
    check(
      `Partido ${status} (visto): no se puede calificar, 409`,
      response.status === 409,
      `status=${response.status}`,
    );
    const stored = await dbRatings(admin, id);
    check(`Partido ${status}: no se creó ninguna fila`, stored.length === 0);
  }

  const notWatched = await putRating(a.token, unwatched, { rating: 3 });
  check(
    'Partido finalizado que A no marcó como visto: 409',
    notWatched.status === 409,
    `status=${notWatched.status}`,
  );
  await setWatched(a.token, unwatched);
  await api('DELETE', `/matches/${unwatched}/watched`, { token: a.token });
  const unmarked = await putRating(a.token, unwatched, { rating: 3 });
  check(
    'Partido finalizado cuyo visto A deshizo: 409',
    unmarked.status === 409,
    `status=${unmarked.status}`,
  );
  check('Ninguno de esos rechazos dejó una fila', (await dbRatings(admin, unwatched)).length === 0);

  const missing = await putRating(a.token, NONEXISTENT_MATCH_ID, { rating: 3 });
  check(
    'PUT sobre un partido inexistente: 404',
    missing.status === 404,
    `status=${missing.status}`,
  );
  const missingGet = await getRating(a.token, NONEXISTENT_MATCH_ID);
  check('GET de nota sobre un partido inexistente: 404', missingGet.status === 404);
  const missingSummary = await getSummary(a.token, NONEXISTENT_MATCH_ID);
  check('GET del resumen de un partido inexistente: 404', missingSummary.status === 404);

  const badId = await putRating(a.token, 'no-es-un-uuid', { rating: 3 });
  check('PUT con id mal formado: 400', badId.status === 400, `status=${badId.status}`);
  check('GET con id mal formado: 400', (await getRating(a.token, 'no-es-un-uuid')).status === 400);
  check(
    'Resumen con id mal formado: 400',
    (await getSummary(a.token, 'no-es-un-uuid')).status === 400,
  );

  const noToken = {
    get: await api('GET', `/matches/${match}/rating`),
    put: await api('PUT', `/matches/${match}/rating`, { rawBody: '{"rating":3}' }),
    summary: await api('GET', `/matches/${match}/rating-summary`),
  };
  check(
    'Sin sesión: GET, PUT y resumen responden 401',
    noToken.get.status === 401 && noToken.put.status === 401 && noToken.summary.status === 401,
    `get=${noToken.get.status}, put=${noToken.put.status}, resumen=${noToken.summary.status}`,
  );
  const badToken = await getRating('token-inventado', match);
  check('Con un token inválido: 401', badToken.status === 401, `status=${badToken.status}`);

  // ── (b) Aislamiento entre usuarios ────────────────────────────────────────
  await setWatched(a.token, other);
  await setWatched(b.token, other);
  await putRating(a.token, other, { rating: 5 });

  const bReadsOther = await getRating(b.token, other);
  check(
    'B no ve la nota de A en otro partido: { rating: null }',
    bReadsOther.status === 200 && sameJson(bReadsOther.body, { rating: null }),
  );
  const spoofedQuery = await getRating(b.token, other, `?userId=${a.userId}`);
  check(
    'B con ?userId=<A> en la query sigue viendo solo lo propio (null)',
    spoofedQuery.status === 200 && sameJson(spoofedQuery.body, { rating: null }),
  );

  const spoofedWrite = await putRating(
    b.token,
    other,
    { rating: 1, userId: a.userId, user_id: a.userId },
    { query: `?userId=${a.userId}`, headers: { 'x-user-id': a.userId } },
  );
  check(
    'B intenta escribir "como A" (body, query y header): 200 pero como B',
    spoofedWrite.status === 200,
  );
  const rowsOther = await dbRatings(admin, other);
  const rowA = rowsOther.find((row) => row.user_id === a.userId);
  const rowB = rowsOther.find((row) => row.user_id === b.userId);
  check(
    'Base: la nota de A (5) quedó intacta y la escritura de B cayó en la fila de B (1)',
    rowsOther.length === 2 && rowA?.rating === 5 && rowB?.rating === 1,
    `filas=${rowsOther.length}`,
  );

  const otherUserRoutes = [
    `/matches/${other}/users/${a.userId}/rating`,
    `/users/${a.userId}/matches/${other}/rating`,
    `/matches/${other}/ratings`,
  ];
  const probes = await Promise.all(
    otherUserRoutes.map((path) => api('GET', path, { token: b.token })),
  );
  check(
    'No existe ninguna ruta para leer la nota de otro usuario (todas 404)',
    probes.every((probe) => probe.status === 404),
    probes.map((probe) => probe.status).join(','),
  );
  const probesWrite = await api('PUT', `/matches/${other}/users/${a.userId}/rating`, {
    token: b.token,
    rawBody: '{"rating":1}',
  });
  check(
    'Tampoco para escribirla (404)',
    probesWrite.status === 404,
    `status=${probesWrite.status}`,
  );

  const summaryOther = await getSummary(b.token, other);
  check(
    'El resumen sí es común a todos: { average: 3, count: 2 } visto por B',
    summaryOther.status === 200 && sameJson(summaryOther.body, { average: 3, count: 2 }),
  );
  const summaryMatchUntouched = await getSummary(a.token, match);
  check(
    'Lo que pasó en el otro partido no tocó el resumen del primero',
    sameJson(summaryMatchUntouched.body, { average: 3, count: 2 }),
  );

  return printResults(results);
}

async function main(): Promise<void> {
  assertLocalSupabase();
  const admin = createServiceRoleClient();
  const fixture = await createFixture(admin);
  const sessions: Session[] = [];

  try {
    const a = await signUp('verify-rating-a');
    sessions.push(a);
    const b = await signUp('verify-rating-b');
    sessions.push(b);
    process.exitCode = (await runChecks(admin, fixture, a, b)) ? 0 : 1;
  } finally {
    const pending = await removeFixture(admin, fixture, sessions);
    if (pending.length > 0) {
      console.error(`\nLa limpieza dejó datos de prueba sin borrar:\n- ${pending.join('\n- ')}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
