import { randomBytes } from 'node:crypto';
import type { OwnProfileStore } from '../../profiles/domain/own-profile-store.js';
import { buildIdentity, MAX_UNIQUE_IDENTITIES, pickFavoriteTeamId } from './demo-identities.js';

/** Identifica el lote en `app_metadata.seed_batch` de cada cuenta que crea esta carga. */
export const DEFAULT_BATCH_ID = 'demo-501-v1';

/** Mínimo de cuentas registradas, cada una con su perfil asociado, que pide el challenge. */
export const TARGET_REGISTERED_ACCOUNTS = 501;

/** Tablas principales cuyo conteo se informa para que el TechLead contraste el requisito de 5.000. */
export const COUNTED_TABLES = [
  'teams',
  'matches',
  'profiles',
  'rooms',
  'room_comments',
  'room_comment_reactions',
  'watched_matches',
  'match_ratings',
  'match_reviews',
] as const;
export type CountedTable = (typeof COUNTED_TABLES)[number];

/** Tablas de actividad que se vacían por `user_id` al retirar el lote. */
export type RowsByUserTable =
  'room_comment_reactions' | 'match_reviews' | 'match_ratings' | 'watched_matches' | 'profiles';

export interface DemoAuthUser {
  id: string;
  email: string | null;
  isAnonymous: boolean;
  /** `app_metadata.seed_batch`, o `null` si la cuenta no la creó ninguna carga. */
  batchId: string | null;
}

/** Huella de los partidos: si no cambia entre antes y después, la carga no los tocó. */
export interface MatchesFingerprint {
  count: number;
  byStatus: Record<string, number>;
  firstKickoff: string | null;
  lastKickoff: string | null;
  /** SHA-256 de `id|kickoff_at|status` de todos los partidos, ordenados por id. */
  digest: string;
}

/** Operaciones administrativas que necesita la carga. La implementación real usa service_role. */
export interface DemoSeedGateway {
  listAuthUsers(): Promise<DemoAuthUser[]>;
  /** Crea la cuenta confirmada, sin enviar correos, marcada con el lote. Devuelve su id. */
  createAuthUser(input: { email: string; password: string; batchId: string }): Promise<string>;
  deleteAuthUser(id: string): Promise<void>;
  listProfileUserIds(): Promise<string[]>;
  countRows(table: CountedTable): Promise<number>;
  matchesFingerprint(): Promise<MatchesFingerprint>;
  deleteRowsByUsers(table: RowsByUserTable, userIds: string[]): Promise<number>;
  listCommentsByAuthors(authorIds: string[]): Promise<{ id: string; authorId: string }[]>;
  /** De `commentIds`, los que tienen un Me gusta de alguien que NO es de `batchUserIds`. */
  listCommentIdsWithReactionsFromOthers(
    commentIds: string[],
    batchUserIds: string[],
  ): Promise<string[]>;
  deleteComments(ids: string[]): Promise<number>;
}

export interface DemoAccountConfig {
  email: string;
  password: string;
  displayName: string;
  bio: string;
}

export interface DemoSeedConfig {
  batchId: string;
  targetAccounts: number;
  emailDomain: string;
  /** Las dos cuentas de demostración: se crean siempre, cuenten o no para el mínimo. */
  demoAccounts: readonly [DemoAccountConfig, DemoAccountConfig];
  /** Máximo de cuentas masivas a crear en esta corrida, para probar con un lote chico. */
  limit?: number;
}

export interface EnvironmentSnapshot {
  /** Cuentas con correo que no son anónimas. */
  registeredAccounts: number;
  anonymousUsers: number;
  profiles: number;
  /** Cuentas registradas que además tienen su perfil: las que cuentan para el requisito. */
  accountsWithProfile: number;
  /** Perfiles cuyo `user_id` no corresponde a una cuenta registrada (sueltos). */
  strayProfiles: number;
  batchAccounts: number;
  batchAccountsWithProfile: number;
  tables: Record<CountedTable, number>;
  matches: MatchesFingerprint;
}

export async function takeSnapshot(
  gateway: DemoSeedGateway,
  batchId: string,
): Promise<EnvironmentSnapshot> {
  const [users, profileIds, matches] = await Promise.all([
    gateway.listAuthUsers(),
    gateway.listProfileUserIds(),
    gateway.matchesFingerprint(),
  ]);

  const profileSet = new Set(profileIds);
  const registered = users.filter((user) => user.email !== null && !user.isAnonymous);
  const registeredIds = new Set(registered.map((user) => user.id));
  const batch = registered.filter((user) => user.batchId === batchId);

  const tables = {} as Record<CountedTable, number>;
  for (const table of COUNTED_TABLES) {
    tables[table] = await gateway.countRows(table);
  }

  return {
    registeredAccounts: registered.length,
    anonymousUsers: users.filter((user) => user.isAnonymous).length,
    profiles: profileSet.size,
    accountsWithProfile: registered.filter((user) => profileSet.has(user.id)).length,
    strayProfiles: profileIds.filter((id) => !registeredIds.has(id)).length,
    batchAccounts: batch.length,
    batchAccountsWithProfile: batch.filter((user) => profileSet.has(user.id)).length,
    tables,
    matches,
  };
}

export interface AccountPlan {
  target: number;
  /** Cuentas con perfil que no son de este lote: lo que el entorno ya aporta. */
  existingOutsideBatch: number;
  /** Cuentas del lote necesarias para llegar al mínimo (incluye las dos de demostración). */
  needed: number;
  /** Cuentas masivas a crear, además de las dos de demostración. */
  bulkTarget: number;
}

/** Cuántas cuentas hacen falta: solo las necesarias para llegar al mínimo, ni una de más. */
export function planAccounts(snapshot: EnvironmentSnapshot, config: DemoSeedConfig): AccountPlan {
  const existingOutsideBatch = snapshot.accountsWithProfile - snapshot.batchAccountsWithProfile;
  const needed = Math.max(0, config.targetAccounts - existingOutsideBatch);
  const bulkTarget = Math.max(0, needed - config.demoAccounts.length);

  if (bulkTarget > MAX_UNIQUE_IDENTITIES) {
    throw new RangeError('No hay suficientes identidades distintas para el mínimo pedido.');
  }

  return { target: config.targetAccounts, existingOutsideBatch, needed, bulkTarget };
}

export interface FailedAccount {
  /** Posición de la cuenta en el lote (`demo` para las de demostración): nunca su correo. */
  ref: string;
  reason: string;
}

export interface SeedAccountsResult {
  createdAccounts: number;
  existingAccounts: number;
  createdProfiles: number;
  conflicts: number;
  failures: FailedAccount[];
  /** Ids de las cuentas de demostración, en el orden de `config.demoAccounts`. */
  demoUserIds: (string | null)[];
}

const CHUNK_SIZE = 5;

/** El motivo de un fallo sin datos de la persona: los correos se tapan y el largo se acota. */
export function sanitizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'error desconocido';

  return raw.replace(/[^\s@]+@[^\s@]+/g, '[correo]').slice(0, 120);
}

function randomPassword(): string {
  // Nadie inicia sesión con estas cuentas: la clave es imposible de adivinar y no se guarda.
  return `${randomBytes(24).toString('base64url')}Aa1!`;
}

interface AccountSpec {
  ref: string;
  email: string;
  password: () => string;
  displayName: string;
  bio: string;
  favoriteTeamId: string | null;
}

/**
 * Crea las cuentas y perfiles que faltan. Es idempotente: una cuenta del lote que ya existe no se
 * vuelve a crear, un perfil que ya existe no se pisa, y un fallo en una cuenta no frena a las demás.
 * Repetir la corrida completa lo que quedó a medias.
 */
export async function seedAccounts(
  deps: { gateway: DemoSeedGateway; profiles: OwnProfileStore },
  config: DemoSeedConfig,
  plan: AccountPlan,
): Promise<SeedAccountsResult> {
  const { gateway, profiles } = deps;
  const users = await gateway.listAuthUsers();
  const byEmail = new Map(
    users.filter((user) => user.email !== null).map((user) => [user.email!.toLowerCase(), user]),
  );
  const teamIds = (await profiles.listTeams()).map((team) => team.id);

  const specs: AccountSpec[] = config.demoAccounts.map((demo, position) => ({
    ref: `demo-${position + 1}`,
    email: demo.email,
    password: () => demo.password,
    displayName: demo.displayName,
    bio: demo.bio,
    favoriteTeamId: pickFavoriteTeamId(position + 1, teamIds),
  }));

  let bulk = 0;
  const bulkLimit = config.limit ?? Number.POSITIVE_INFINITY;
  for (let index = 1; index <= plan.bulkTarget; index += 1) {
    const identity = buildIdentity(index);
    const email = `${identity.emailLocalPart}@${config.emailDomain}`;
    const exists = byEmail.has(email.toLowerCase());

    // El tope de la corrida solo frena altas nuevas: las que ya existen se siguen comprobando.
    if (!exists && bulk >= bulkLimit) continue;
    if (!exists) bulk += 1;

    specs.push({
      ref: `#${index}`,
      email,
      password: randomPassword,
      displayName: identity.displayName,
      bio: identity.bio,
      favoriteTeamId: pickFavoriteTeamId(index + config.demoAccounts.length, teamIds),
    });
  }

  const result: SeedAccountsResult = {
    createdAccounts: 0,
    existingAccounts: 0,
    createdProfiles: 0,
    conflicts: 0,
    failures: [],
    demoUserIds: config.demoAccounts.map(() => null),
  };

  for (let start = 0; start < specs.length; start += CHUNK_SIZE) {
    const chunk = specs.slice(start, start + CHUNK_SIZE);

    await Promise.all(
      chunk.map(async (spec, offset) => {
        try {
          const known = byEmail.get(spec.email.toLowerCase());

          if (known && known.batchId !== config.batchId) {
            // Un correo que ya es de otra persona no se toca ni se reutiliza.
            result.conflicts += 1;
            return;
          }

          let userId: string;

          if (known) {
            userId = known.id;
            result.existingAccounts += 1;
          } else {
            userId = await gateway.createAuthUser({
              email: spec.email,
              password: spec.password(),
              batchId: config.batchId,
            });
            result.createdAccounts += 1;
          }

          if ((await profiles.getOwnProfile(userId)) === null) {
            await profiles.saveOwnProfile(userId, {
              displayName: spec.displayName,
              bio: spec.bio,
              favoriteTeamId: spec.favoriteTeamId,
            });
            result.createdProfiles += 1;
          }

          const demoPosition = start + offset;
          if (demoPosition < config.demoAccounts.length) {
            result.demoUserIds[demoPosition] = userId;
          }
        } catch (error) {
          result.failures.push({ ref: spec.ref, reason: sanitizeReason(error) });
        }
      }),
    );
  }

  return result;
}

export interface RemoveBatchResult {
  batchAccounts: number;
  /** Cuentas que se conservan porque un comentario suyo tiene reacciones de otras personas. */
  retainedAccounts: number;
  /** Comentarios del lote que se borran / que se conservan por tener reacciones ajenas. */
  removableComments: number;
  blockedComments: number;
  deleted: Record<RowsByUserTable | 'room_comments' | 'auth_users', number>;
}

/**
 * Retira SOLO lo que creó el lote: la actividad de sus cuentas, sus perfiles y las cuentas. No toca
 * partidos ni cuentas ajenas. Un comentario del lote con reacciones de otras personas no se borra
 * (serían datos ajenos): su autor se conserva entero para no romper la relación, y eso se informa.
 *
 * Sin `apply` no escribe nada: devuelve lo que haría.
 */
export async function removeBatch(
  gateway: DemoSeedGateway,
  batchId: string,
  options: { apply: boolean },
): Promise<RemoveBatchResult> {
  const users = (await gateway.listAuthUsers()).filter((user) => user.batchId === batchId);
  const batchIds = users.map((user) => user.id);
  const deleted: RemoveBatchResult['deleted'] = {
    room_comment_reactions: 0,
    room_comments: 0,
    match_reviews: 0,
    match_ratings: 0,
    watched_matches: 0,
    profiles: 0,
    auth_users: 0,
  };

  if (batchIds.length === 0) {
    return {
      batchAccounts: 0,
      retainedAccounts: 0,
      removableComments: 0,
      blockedComments: 0,
      deleted,
    };
  }

  const comments = await gateway.listCommentsByAuthors(batchIds);
  const blocked = new Set(
    await gateway.listCommentIdsWithReactionsFromOthers(
      comments.map((comment) => comment.id),
      batchIds,
    ),
  );
  const retained = new Set(
    comments.filter((comment) => blocked.has(comment.id)).map((comment) => comment.authorId),
  );
  const removableComments = comments
    .filter((comment) => !retained.has(comment.authorId))
    .map((comment) => comment.id);
  const removableUsers = batchIds.filter((id) => !retained.has(id));
  const summary = {
    batchAccounts: batchIds.length,
    retainedAccounts: retained.size,
    removableComments: removableComments.length,
    blockedComments: blocked.size,
  };

  if (!options.apply) {
    return { ...summary, deleted };
  }

  // Los Me gusta del lote salen primero y de todas sus cuentas: un comentario que se borra no
  // puede tener reacciones colgando, ni siquiera las de una cuenta que se conserva.
  deleted.room_comment_reactions = await gateway.deleteRowsByUsers(
    'room_comment_reactions',
    batchIds,
  );
  deleted.room_comments = await gateway.deleteComments(removableComments);
  deleted.match_reviews = await gateway.deleteRowsByUsers('match_reviews', removableUsers);
  deleted.match_ratings = await gateway.deleteRowsByUsers('match_ratings', removableUsers);
  deleted.watched_matches = await gateway.deleteRowsByUsers('watched_matches', removableUsers);
  deleted.profiles = await gateway.deleteRowsByUsers('profiles', removableUsers);

  for (const id of removableUsers) {
    await gateway.deleteAuthUser(id);
    deleted.auth_users += 1;
  }

  return { ...summary, deleted };
}
