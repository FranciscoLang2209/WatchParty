import type { SupabaseClient } from '@supabase/supabase-js';
import { createAnonClient, createServiceRoleClient } from './utils/supabase-clients.js';
import { printResults, type CheckResult } from './utils/db-checks.js';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = 'Verify-History-Pass-1!';
// Página chica a propósito: con pocos partidos locales igual hay varias páginas.
const PAGE_LIMIT = 2;
const FIXTURE_PROVIDER = 'verify-history';
const FIXTURE_MATCHES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

interface HistoryItem {
  match: { id: string };
  watchedAt: string;
}

interface HistoryPage {
  items: HistoryItem[];
  nextCursor: { watchedAt: string; matchId: string } | null;
}

function createEmail(prefix: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}@watchparty.local`;
}

async function signUp(prefix: string): Promise<{ email: string; token: string }> {
  const email = createEmail(prefix);
  const { data, error } = await createAnonClient().auth.signUp({ email, password: PASSWORD });
  if (error || !data.session) {
    throw new Error(`No se pudo crear el usuario temporal: ${error?.message ?? 'sin sesión'}`);
  }
  return { email, token: data.session.access_token };
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

async function api(path: string, token?: string, method = 'GET'): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function setWatched(token: string, matchId: string, watched: boolean): Promise<void> {
  const response = await api(`/matches/${matchId}/watched`, token, watched ? 'PUT' : 'DELETE');
  if (!response.ok) {
    throw new Error(
      `No se pudo ${watched ? 'marcar' : 'desmarcar'} el partido (${response.status}).`,
    );
  }
}

/** Recorre todas las páginas del historial; devuelve los ids en orden y cuántas páginas hubo. */
async function readHistory(token: string): Promise<{ items: HistoryItem[]; pages: number }> {
  const items: HistoryItem[] = [];
  let cursor: HistoryPage['nextCursor'] = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set('beforeWatchedAt', cursor.watchedAt);
      params.set('beforeMatchId', cursor.matchId);
    }
    const response = await api(`/me/watched-matches?${params}`, token);
    if (response.status !== 200) {
      throw new Error(`GET /me/watched-matches respondió ${response.status}.`);
    }
    const page = (await response.json()) as HistoryPage;
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);

  return { items, pages };
}

function ids(items: HistoryItem[]): string[] {
  return items.map((item) => item.match.id);
}

function sameList(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((id, i) => id === expected[i]);
}

interface MatchFixture {
  teamIds: string[];
  matchIds: string[];
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
 * Partidos propios del recorrido, con service_role (como el backend). No
 * depende del seed ni de la ventana de agenda de `GET /matches`: el detalle y
 * el historial se resuelven por id, así que alcanza con que existan.
 */
async function createMatchFixture(admin: SupabaseClient): Promise<MatchFixture> {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  const matches = await insertOrFail<{ id: string; external_id: string }>(
    'crear los partidos de prueba',
    admin
      .from('matches')
      .insert(
        Array.from({ length: FIXTURE_MATCHES }, (_, i) => ({
          provider: FIXTURE_PROVIDER,
          external_id: `${run}-match-${i}`,
          home_team_id: home,
          away_team_id: away,
          competition_external_id: FIXTURE_PROVIDER,
          season: '2026',
          kickoff_at: new Date(Date.now() + (i + 1) * DAY_MS).toISOString(),
          status: 'scheduled',
        })),
      )
      .select('id, external_id'),
  );

  // Orden estable: el del índice con que se crearon.
  matches.sort((x, y) => x.external_id.localeCompare(y.external_id));

  return { teamIds: teams.map((team) => team.id), matchIds: matches.map((match) => match.id) };
}

/** Borra lo que creó el recorrido. Los vistos van primero: sus FK no cascadean. */
async function removeMatchFixture(admin: SupabaseClient, fixture: MatchFixture): Promise<void> {
  await admin.from('watched_matches').delete().in('match_id', fixture.matchIds);
  await admin.from('matches').delete().in('id', fixture.matchIds);
  await admin.from('teams').delete().in('id', fixture.teamIds);
}

/**
 * Recorrido integrado del historial de vistos (WAT-223) contra la API y el
 * Supabase locales: dos usuarios temporales, varias páginas, orden, ausencia
 * de duplicados y de datos ajenos, persistencia en una sesión nueva y
 * navegación al detalle. Crea usuarios temporales y sus propios partidos
 * (que borra al final): no depende del seed. Solo para local.
 */
async function runChecks(matchIds: string[]): Promise<boolean> {
  const results: CheckResult[] = [];

  const unauthenticated = await api('/me/watched-matches');
  results.push({
    label: 'Sin sesión, el historial responde 401',
    passed: unauthenticated.status === 401,
    detail: `status=${unauthenticated.status}`,
  });

  const a = await signUp('verify-history-a');
  const b = await signUp('verify-history-b');

  const empty = await readHistory(a.token);
  results.push({
    label: 'Usuario sin vistos: historial vacío y sin página siguiente',
    passed: empty.items.length === 0 && empty.pages === 1,
    detail: `items=${empty.items.length}, páginas=${empty.pages}`,
  });

  // Marcados en orden: el más reciente es el último.
  for (const matchId of matchIds) {
    await setWatched(a.token, matchId, true);
  }
  const expectedA = [...matchIds].reverse();

  const historyA = await readHistory(a.token);
  results.push({
    label: 'Orden del más reciente al más antiguo',
    passed: sameList(ids(historyA.items), expectedA),
    detail: `esperado ${expectedA.length} partidos en orden inverso al marcado`,
  });
  results.push({
    label: `Paginación de a ${PAGE_LIMIT}: varias páginas sin duplicados ni faltantes`,
    passed:
      historyA.pages === Math.ceil(matchIds.length / PAGE_LIMIT) &&
      new Set(ids(historyA.items)).size === historyA.items.length &&
      historyA.items.length === matchIds.length,
    detail: `páginas=${historyA.pages}, items=${historyA.items.length}`,
  });
  results.push({
    label: 'watchedAt no crece entre un item y el siguiente',
    passed: historyA.items.every(
      (item, i) => i === 0 || item.watchedAt <= historyA.items[i - 1]!.watchedAt,
    ),
  });

  const details = await Promise.all(
    historyA.items.map((item) => api(`/matches/${item.match.id}`, a.token)),
  );
  results.push({
    label: 'Cada item navega a un detalle existente (GET /matches/:id 200)',
    passed: details.every((response) => response.status === 200),
    detail: details.map((response) => response.status).join(','),
  });

  await setWatched(b.token, matchIds[1]!, true);
  const historyB = await readHistory(b.token);
  results.push({
    label: 'Otro usuario solo ve lo propio',
    passed: sameList(ids(historyB.items), [matchIds[1]!]),
    detail: `items de B=${historyB.items.length}`,
  });

  const historyAAfterB = await readHistory(a.token);
  results.push({
    label: 'Lo que marca otro usuario no aparece ni altera el historial propio',
    passed: sameList(ids(historyAAfterB.items), expectedA),
  });

  const secondSession = await signIn(a.email);
  const historyNewSession = await readHistory(secondSession);
  results.push({
    label: 'El historial persiste en una sesión nueva del mismo usuario',
    passed:
      secondSession !== a.token && sameList(ids(historyNewSession.items), ids(historyA.items)),
  });

  await setWatched(a.token, matchIds[2]!, false);
  const afterUndo = await readHistory(secondSession);
  results.push({
    label: 'Deshacer un visto lo quita del historial (visto desde la otra sesión)',
    passed: sameList(
      ids(afterUndo.items),
      expectedA.filter((id) => id !== matchIds[2]),
    ),
    detail: `items=${afterUndo.items.length}`,
  });

  const invalid = await api('/me/watched-matches?limit=0', a.token);
  results.push({
    label: 'Un tamaño de página inválido responde 400',
    passed: invalid.status === 400,
    detail: `status=${invalid.status}`,
  });

  return printResults(results);
}

async function main(): Promise<void> {
  const admin = createServiceRoleClient();
  const fixture = await createMatchFixture(admin);

  try {
    process.exitCode = (await runChecks(fixture.matchIds)) ? 0 : 1;
  } finally {
    await removeMatchFixture(admin, fixture);
  }
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
