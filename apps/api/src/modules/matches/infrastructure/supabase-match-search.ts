import type { SupabaseClient } from '@supabase/supabase-js';
import type { Match, MatchStatus } from '../domain/match.js';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_LIMIT,
  type MatchSearch,
  type MatchSearchPage,
  type SearchPage,
  type SearchQuery,
  type TeamSearchPage,
  type TeamSearchResult,
} from '../domain/match-search.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';

const MATCH_STATUSES: readonly MatchStatus[] = [
  'scheduled',
  'live',
  'finished',
  'postponed',
  'cancelled',
];

function isMatchStatus(value: string): value is MatchStatus {
  return (MATCH_STATUSES as readonly string[]).includes(value);
}

// Mismo hint de relación que SupabaseMatchStore: matches tiene dos FKs a teams.
const MATCH_SELECT_WITH_TEAMS =
  'id, kickoff_at, status, home_team:teams!matches_home_team_id_fkey(name), away_team:teams!matches_away_team_id_fkey(name)';

interface EmbeddedTeamName {
  name: string;
}

interface MatchRowWithTeams {
  id: string;
  kickoff_at: string;
  status: string;
  home_team: EmbeddedTeamName | null;
  away_team: EmbeddedTeamName | null;
}

function toMatch(row: MatchRowWithTeams): Match {
  if (!row.home_team || !row.away_team) {
    throw new SupabasePersistenceError(
      `El partido ${row.id} no pudo resolver sus equipos desde la relación.`,
    );
  }
  if (!isMatchStatus(row.status)) {
    throw new SupabasePersistenceError(
      `El partido ${row.id} tiene un status fuera del contrato canónico de Match.`,
    );
  }
  return {
    id: row.id,
    homeTeam: row.home_team.name,
    awayTeam: row.away_team.name,
    kickoffAt: new Date(row.kickoff_at).toISOString(),
    status: row.status,
  };
}

/** Un límite fuera de rango (o directamente inválido) se ajusta, no falla. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), SEARCH_MIN_LIMIT), SEARCH_MAX_LIMIT);
}

/**
 * Tamaño de página para el lookup interno de equipos coincidentes (ver
 * `findAllMatchingTeamIds`). Tiene que quedar cómodamente por debajo de
 * `max_rows` en `supabase/config.toml` (1000 en local; confirmar que el
 * proyecto remoto use el mismo valor): ese es el límite que PostgREST
 * trunca en silencio si se confía en que una sola consulta devuelve "todo".
 * Acá se pagina explícitamente hasta agotar los resultados, así nunca se
 * depende de ese límite del servidor.
 */
export const TEAM_LOOKUP_BATCH_SIZE = 500;

// Separador improbable en un nombre real; igual el cursor nunca lo expone en
// texto plano porque va codificado en base64url.
const CURSOR_SEPARATOR = '\u0000';

function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(`${sortValue}${CURSOR_SEPARATOR}${id}`, 'utf8').toString('base64url');
}

interface DecodedCursor {
  sortValue: string;
  id: string;
}

// Mismo patrón que UUID_PATTERN en modules/comments/domain/room-comment-store.ts.
// `id` siempre es un uuid de Postgres (teams.id/matches.id): validarlo acá,
// no solo buscar el separador, es lo que impide que un cursor alterado
// meta texto arbitrario en el filtro .or() de abajo. Al ser estrictamente
// hexadecimal con guiones, un id válido tampoco puede contener ningún
// carácter reservado de PostgREST, así que no hace falta además escaparlo.
const CURSOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new Error('Cursor de búsqueda inválido.');
  }

  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex === -1) {
    throw new Error('Cursor de búsqueda inválido.');
  }

  const sortValue = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);

  if (sortValue === '' || !CURSOR_ID_PATTERN.test(id)) {
    throw new Error('Cursor de búsqueda inválido.');
  }

  return { sortValue, id };
}

// PostgREST reserva , ( ) " \ para su propia sintaxis de filtro: un valor
// que los contenga va entre comillas dobles, escapando las comillas y las
// barras invertidas internas con una barra invertida (convención de
// PostgREST: no se duplica la comilla, como haría SQL).
function quoteFilterValue(value: string): string {
  if (!/[,()"\\]/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Escapa los caracteres especiales de ILIKE para que el texto buscado se
// trate siempre como literal, nunca como patrón.
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Implementación de `MatchSearch` respaldada por Supabase (WAT-167).
 *
 * Paginación por cursor (keyset), no por offset: cada página pide
 * `limit + 1` filas, usa la fila de más para saber si hay otra página y
 * arma el cursor con `(columna de orden, id)` de la última fila devuelta.
 * Evita el problema clásico de offset con datos que cambian entre páginas.
 */
export class SupabaseMatchSearch implements MatchSearch {
  constructor(private readonly client: SupabaseClient) {}

  async search(query: SearchQuery): Promise<SearchPage> {
    const limit = clampLimit(query.limit);
    const text = query.query.trim();
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    return query.kind === 'teams'
      ? this.searchTeams(text, limit, cursor)
      : this.searchMatches(text, limit, cursor);
  }

  private async searchTeams(
    text: string,
    limit: number,
    cursor: DecodedCursor | null,
  ): Promise<TeamSearchPage> {
    let builder = this.client
      .from('teams')
      .select('id, name')
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1);

    if (text !== '') {
      builder = builder.ilike('name', `%${escapeLikePattern(text)}%`);
    }

    if (cursor) {
      const value = quoteFilterValue(cursor.sortValue);
      builder = builder.or(`name.gt.${value},and(name.eq.${value},id.gt.${cursor.id})`);
    }

    const { data, error } = await builder;

    if (error) {
      throw new SupabasePersistenceError('No se pudo buscar equipos.', error);
    }

    const rows = (data ?? []) as TeamSearchResult[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      kind: 'teams',
      items: page,
      nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
    };
  }

  /**
   * Todos los equipos cuyo nombre coincide con `text`, sin depender del
   * `max_rows` del servidor: pagina por `id` hasta que una página devuelve
   * menos filas que `TEAM_LOOKUP_BATCH_SIZE`. Una sola consulta sin límite
   * explícito corre el riesgo de que PostgREST trunque en silencio con un
   * texto común, dejando afuera partidos de equipos que sí coincidían.
   */
  private async findAllMatchingTeamIds(text: string): Promise<string[]> {
    const ids: string[] = [];
    let lastId: string | null = null;

    for (;;) {
      let builder = this.client
        .from('teams')
        .select('id')
        .ilike('name', `%${escapeLikePattern(text)}%`)
        .order('id', { ascending: true })
        .limit(TEAM_LOOKUP_BATCH_SIZE);

      if (lastId !== null) {
        builder = builder.gt('id', lastId);
      }

      const { data, error } = await builder;

      if (error) {
        throw new SupabasePersistenceError('No se pudo buscar equipos para el partido.', error);
      }

      const rows = (data ?? []) as { id: string }[];
      for (const row of rows) ids.push(row.id);

      const last = rows[rows.length - 1];
      if (rows.length < TEAM_LOOKUP_BATCH_SIZE || !last) break;

      lastId = last.id;
    }

    return ids;
  }

  private async searchMatches(
    text: string,
    limit: number,
    cursor: DecodedCursor | null,
  ): Promise<MatchSearchPage> {
    let teamIds: string[] | null = null;

    if (text !== '') {
      teamIds = await this.findAllMatchingTeamIds(text);

      // Ningún equipo coincide: ningún partido puede coincidir. Se corta acá
      // para no tocar la tabla matches ni armar un OR con una lista vacía.
      if (teamIds.length === 0) {
        return { kind: 'matches', items: [], nextCursor: null };
      }
    }

    let builder = this.client
      .from('matches')
      .select(MATCH_SELECT_WITH_TEAMS)
      .order('kickoff_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1);

    if (teamIds) {
      const idList = teamIds.join(',');
      builder = builder.or(`home_team_id.in.(${idList}),away_team_id.in.(${idList})`);
    }

    if (cursor) {
      const value = quoteFilterValue(cursor.sortValue);
      builder = builder.or(`kickoff_at.gt.${value},and(kickoff_at.eq.${value},id.gt.${cursor.id})`);
    }

    const { data, error } = await builder;

    if (error) {
      throw new SupabasePersistenceError('No se pudo buscar partidos.', error);
    }

    const rows = (data as unknown as MatchRowWithTeams[]) ?? [];
    const pageRows = rows.slice(0, limit);
    const lastRow = pageRows[pageRows.length - 1];

    return {
      kind: 'matches',
      items: pageRows.map(toMatch),
      nextCursor:
        rows.length > limit && lastRow ? encodeCursor(lastRow.kickoff_at, lastRow.id) : null,
    };
  }
}
