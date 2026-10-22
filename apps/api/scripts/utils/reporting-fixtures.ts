import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Partidos sembrados por supabase/seed.sql (WAT-103).
export const MATCH_1 = 'a1111111-1111-1111-1111-111111111111';
export const MATCH_2 = 'a2222222-2222-2222-2222-222222222222';
export const MATCH_3 = 'a3333333-3333-3333-3333-333333333333';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Conexión directa a Postgres: los agregados viven en el esquema `reporting`,
 * que PostgREST no expone, y los checks necesitan fijar fechas y cambiar de
 * rol. Solo contra el Supabase local: los checks siembran datos sintéticos.
 */
export function createLocalDatabaseClient(): pg.Client {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error('Falta la variable de entorno SUPABASE_DB_URL. Revisá tu archivo .env.');
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error('SUPABASE_DB_URL debe apuntar al Supabase local.');
  }
  return new pg.Client({ connectionString: url });
}

/** Fila que devuelven los agregados de `reporting`. */
export interface Aggregate {
  value: number | null;
  omission_reason: string | null;
}

export function describe(aggregate: Aggregate): string {
  return `value=${aggregate.value}, omission_reason=${aggregate.omission_reason}`;
}

/** Ejecuta `sql` en un savepoint y devuelve el código de error, o null si no falló. */
export async function errorCodeOf(client: pg.Client, sql: string): Promise<string | null> {
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

export async function seedUser(client: pg.Client): Promise<string> {
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

export async function watch(client: pg.Client, userId: string, matchId: string, at: string) {
  await client.query(
    'insert into watched_matches (user_id, match_id, created_at) values ($1, $2, $3)',
    [userId, matchId, at],
  );
}

/** Siembra un comentario y devuelve su id. */
export async function comment(
  client: pg.Client,
  userId: string,
  matchId: string,
  at: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into room_comments (room_id, author_id, body, client_request_id, created_at)
     values ($1, $2, 'comentario de prueba', gen_random_uuid(), $3)
     returning id`,
    [await roomOf(client, matchId), userId, at],
  );
  return rows[0]!.id;
}

export async function react(client: pg.Client, userId: string, commentId: string, at: string) {
  await client.query(
    'insert into room_comment_reactions (comment_id, user_id, created_at) values ($1, $2, $3)',
    [commentId, userId, at],
  );
}

export async function rateMatch(
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

export async function markTechnical(client: pg.Client, userId: string) {
  await client.query('insert into reporting.technical_accounts (user_id) values ($1)', [userId]);
}

/**
 * Le da a `role` solo USAGE sobre `reporting` y EXECUTE sobre `fn`, y pasa a
 * actuar como ese rol hasta el fin de la transacción. USAGE lo da el dueño del
 * esquema, igual que la migración de WAT-220.
 */
export async function actAsReporter(client: pg.Client, role: string, fn: string) {
  await client.query('set local role watchparty_reporter_source');
  await client.query(`grant usage on schema reporting to ${role}`);
  await client.query('reset role');
  await client.query(`grant execute on function ${fn} to ${role}`);
  await client.query(`set local role ${role}`);
}
