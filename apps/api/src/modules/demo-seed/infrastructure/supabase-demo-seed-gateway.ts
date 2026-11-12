import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CountedTable,
  DemoAuthUser,
  DemoSeedGateway,
  MatchesFingerprint,
  RowsByUserTable,
} from '../application/demo-seed.js';

const PAGE_SIZE = 1000;
const IN_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }

  return result;
}

function fail(action: string, error: { message: string } | null): never {
  // El mensaje del proveedor puede traer un correo: quien lo muestra lo sanea (`sanitizeReason`).
  throw new Error(`${action}: ${error?.message ?? 'sin detalle'}`);
}

/**
 * Operaciones administrativas de la carga de demo, con el cliente de service_role (el mismo que usa
 * el resto de la API del lado servidor). Las cuentas se crean y se borran con la Admin API de
 * Supabase Auth, que no envía ningún correo.
 */
export class SupabaseDemoSeedGateway implements DemoSeedGateway {
  constructor(private readonly client: SupabaseClient) {}

  async listAuthUsers(): Promise<DemoAuthUser[]> {
    const users: DemoAuthUser[] = [];

    for (let page = 1; ; page += 1) {
      const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
      if (error) fail('No se pudo listar las cuentas', error);

      for (const user of data.users) {
        const batch = (user.app_metadata as Record<string, unknown> | undefined)?.seed_batch;

        users.push({
          id: user.id,
          email: user.email ?? null,
          isAnonymous: user.is_anonymous === true,
          batchId: typeof batch === 'string' ? batch : null,
        });
      }

      if (data.users.length < PAGE_SIZE) return users;
    }
  }

  async createAuthUser(input: {
    email: string;
    password: string;
    batchId: string;
  }): Promise<string> {
    const { data, error } = await this.client.auth.admin.createUser({
      email: input.email,
      password: input.password,
      // Confirmada de entrada: la Admin API no manda correos, así que no hay nada que confirmar.
      email_confirm: true,
      app_metadata: { seed_batch: input.batchId },
    });

    if (error || !data.user) fail('No se pudo crear la cuenta', error);

    return data.user.id;
  }

  async deleteAuthUser(id: string): Promise<void> {
    const { error } = await this.client.auth.admin.deleteUser(id);
    if (error) fail('No se pudo borrar la cuenta', error);
  }

  async listProfileUserIds(): Promise<string[]> {
    const ids: string[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.client
        .from('profiles')
        .select('user_id')
        .order('user_id')
        .range(from, from + PAGE_SIZE - 1);
      if (error) fail('No se pudo listar los perfiles', error);

      ids.push(...(data ?? []).map((row) => row.user_id as string));

      if ((data ?? []).length < PAGE_SIZE) return ids;
    }
  }

  async countRows(table: CountedTable): Promise<number> {
    const { count, error } = await this.client
      .from(table)
      .select('*', { count: 'exact', head: true });
    if (error) fail(`No se pudo contar ${table}`, error);

    return count ?? 0;
  }

  async matchesFingerprint(): Promise<MatchesFingerprint> {
    const hash = createHash('sha256');
    const byStatus: Record<string, number> = {};
    let count = 0;
    let firstKickoff: string | null = null;
    let lastKickoff: string | null = null;

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.client
        .from('matches')
        .select('id, kickoff_at, status')
        .order('id')
        .range(from, from + PAGE_SIZE - 1);
      if (error) fail('No se pudo leer los partidos', error);

      for (const row of data ?? []) {
        const kickoff = String(row.kickoff_at);
        const status = String(row.status);

        hash.update(`${row.id}|${kickoff}|${status}\n`);
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        count += 1;
        if (firstKickoff === null || kickoff < firstKickoff) firstKickoff = kickoff;
        if (lastKickoff === null || kickoff > lastKickoff) lastKickoff = kickoff;
      }

      if ((data ?? []).length < PAGE_SIZE) break;
    }

    return { count, byStatus, firstKickoff, lastKickoff, digest: hash.digest('hex') };
  }

  async deleteRowsByUsers(table: RowsByUserTable, userIds: string[]): Promise<number> {
    let deleted = 0;

    for (const group of chunks(userIds, IN_CHUNK)) {
      const { count, error } = await this.client
        .from(table)
        .delete({ count: 'exact' })
        .in('user_id', group);
      if (error) fail(`No se pudo borrar de ${table}`, error);

      deleted += count ?? 0;
    }

    return deleted;
  }

  async listCommentsByAuthors(authorIds: string[]): Promise<{ id: string; authorId: string }[]> {
    const comments: { id: string; authorId: string }[] = [];

    for (const group of chunks(authorIds, IN_CHUNK)) {
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await this.client
          .from('room_comments')
          .select('id, author_id')
          .in('author_id', group)
          .order('id')
          .range(from, from + PAGE_SIZE - 1);
        if (error) fail('No se pudo listar los comentarios', error);

        comments.push(
          ...(data ?? []).map((row) => ({
            id: row.id as string,
            authorId: row.author_id as string,
          })),
        );

        if ((data ?? []).length < PAGE_SIZE) break;
      }
    }

    return comments;
  }

  async listCommentIdsWithReactionsFromOthers(
    commentIds: string[],
    batchUserIds: string[],
  ): Promise<string[]> {
    const batch = new Set(batchUserIds);
    const blocked = new Set<string>();

    for (const group of chunks(commentIds, IN_CHUNK)) {
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await this.client
          .from('room_comment_reactions')
          .select('comment_id, user_id')
          .in('comment_id', group)
          .order('comment_id')
          .order('user_id')
          .range(from, from + PAGE_SIZE - 1);
        if (error) fail('No se pudo leer las reacciones', error);

        for (const row of data ?? []) {
          if (!batch.has(row.user_id as string)) blocked.add(row.comment_id as string);
        }

        if ((data ?? []).length < PAGE_SIZE) break;
      }
    }

    return [...blocked];
  }

  /** Los partidos terminados más recientes, para elegir los de la demo. Solo lectura. */
  async listFinishedMatchCandidates(
    limit: number,
  ): Promise<{ id: string; kickoffAt: string; home: string; away: string }[]> {
    const { data, error } = await this.client
      .from('matches')
      .select(
        'id, kickoff_at, home:teams!matches_home_team_id_fkey(name), away:teams!matches_away_team_id_fkey(name)',
      )
      .eq('status', 'finished')
      .order('kickoff_at', { ascending: false })
      .order('id')
      .limit(limit);
    if (error) fail('No se pudo listar los partidos finalizados', error);

    const name = (team: unknown): string => {
      const value = Array.isArray(team) ? team[0] : team;

      return (value as { name?: string } | null)?.name ?? '?';
    };

    return (data ?? []).map((row) => ({
      id: row.id as string,
      kickoffAt: String(row.kickoff_at),
      home: name(row.home),
      away: name(row.away),
    }));
  }

  async deleteComments(ids: string[]): Promise<number> {
    let deleted = 0;

    for (const group of chunks(ids, IN_CHUNK)) {
      const { count, error } = await this.client
        .from('room_comments')
        .delete({ count: 'exact' })
        .in('id', group);
      if (error) fail('No se pudo borrar comentarios', error);

      deleted += count ?? 0;
    }

    return deleted;
  }
}
