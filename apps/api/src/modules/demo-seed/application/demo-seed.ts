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
  /**
   * De `commentIds`, los que tienen un Me gusta de alguien que NO es de `batchUserIds`. Es una
   * lectura informativa (para el simulacro): NO sirve para decidir un borrado, porque entre leer y
   * borrar puede llegar una reacción ajena.
   */
  listCommentIdsWithReactionsFromOthers(
    commentIds: string[],
    batchUserIds: string[],
  ): Promise<string[]>;
  /**
   * `true` solo si `deleteCommentsWithoutReactions` comprueba y borra en un único paso atómico, de
   * modo que una reacción que llegue en ese instante no se pierda. Mientras sea `false`, la retirada
   * efectiva está deshabilitada.
   */
  readonly atomicCommentRemoval: boolean;
  /**
   * Borra, de forma atómica, los comentarios de `ids` que NO tienen ninguna reacción, y devuelve los
   * borrados y los que se omitieron porque tenían alguna. Nunca borra un comentario con reacciones:
   * la base borraría también esas reacciones por la relación, y podrían ser de otra persona.
   */
  deleteCommentsWithoutReactions(ids: string[]): Promise<{ deleted: string[]; skipped: string[] }>;
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

  const result: SeedAccountsResult = {
    createdAccounts: 0,
    existingAccounts: 0,
    createdProfiles: 0,
    conflicts: 0,
    failures: [],
    demoUserIds: config.demoAccounts.map(() => null),
  };

  // Los lugares del lote se ocupan con identidades libres. Un correo que ya es de otra persona NO
  // ocupa un lugar: se saltea y se sigue con la identidad siguiente, así el total no queda corto. La
  // elección es determinista, de modo que repetir la corrida reconoce las mismas cuentas.
  let newAccounts = 0;
  let slots = 0;
  const newAccountsLimit = config.limit ?? Number.POSITIVE_INFINITY;

  for (let index = 1; slots < plan.bulkTarget; index += 1) {
    if (index > MAX_UNIQUE_IDENTITIES) {
      result.failures.push({
        ref: 'lote',
        reason: 'No hay identidades libres suficientes para completar el lote.',
      });
      break;
    }

    const identity = buildIdentity(index);
    const email = `${identity.emailLocalPart}@${config.emailDomain}`;
    const known = byEmail.get(email.toLowerCase());

    if (known && known.batchId !== config.batchId) {
      result.conflicts += 1;
      continue;
    }

    slots += 1;

    // El tope de la corrida solo frena altas nuevas: las del lote que ya existen se siguen
    // comprobando para completar su perfil. El lugar queda reservado para una corrida posterior.
    if (!known) {
      if (newAccounts >= newAccountsLimit) continue;
      newAccounts += 1;
    }

    specs.push({
      ref: `#${index}`,
      email,
      password: randomPassword,
      displayName: identity.displayName,
      bio: identity.bio,
      favoriteTeamId: pickFavoriteTeamId(index + config.demoAccounts.length, teamIds),
    });
  }

  for (let start = 0; start < specs.length; start += CHUNK_SIZE) {
    const chunk = specs.slice(start, start + CHUNK_SIZE);

    await Promise.all(
      chunk.map(async (spec, offset) => {
        try {
          const known = byEmail.get(spec.email.toLowerCase());

          if (known && known.batchId !== config.batchId) {
            // Solo puede pasar con una cuenta de demostración (las masivas ya se saltearon arriba).
            // Un correo que ya es de otra persona no se toca ni se reutiliza, y no es un hecho
            // menor: esa cuenta de demostración no existe, así que se informa como fallo.
            result.conflicts += 1;
            result.failures.push({
              ref: spec.ref,
              reason: 'El correo ya pertenece a una cuenta que no es del lote: no se toca.',
            });
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
  /**
   * Comentarios del lote que se borran / que se conservan por tener reacciones. En el simulacro son
   * una estimación (una lectura); con `apply` son lo que el borrado atómico realmente hizo.
   */
  removableComments: number;
  blockedComments: number;
  deleted: Record<RowsByUserTable | 'room_comments' | 'auth_users', number>;
}

/** La retirada efectiva no se puede hacer con seguridad con el gateway recibido. */
export class RemovalDisabledError extends Error {
  constructor() {
    super(
      'La retirada efectiva está deshabilitada: el borrado de comentarios todavía no es atómico, y una reacción ajena que llegue entre la comprobación y el borrado se perdería. El simulacro (sin --apply) sigue disponible.',
    );
    this.name = 'RemovalDisabledError';
  }
}

/**
 * Retira SOLO lo que creó el lote: la actividad de sus cuentas, sus perfiles y las cuentas. No toca
 * partidos ni cuentas ajenas.
 *
 * Un comentario con reacciones nunca se borra: la base eliminaría esas reacciones por la relación, y
 * pueden ser de otra persona. Para que ninguna llegue entre «mirar» y «borrar», no se mira antes: se
 * le pide al gateway un único borrado atómico de los comentarios SIN reacciones, y los que vuelven
 * como omitidos marcan a los autores que se conservan.
 *
 * Sin `apply` no escribe nada: devuelve lo que haría (una estimación). Con `apply`, si el gateway no
 * garantiza el borrado atómico, se niega a escribir.
 */
export async function removeBatch(
  gateway: DemoSeedGateway,
  batchId: string,
  options: { apply: boolean },
): Promise<RemoveBatchResult> {
  if (options.apply && !gateway.atomicCommentRemoval) {
    throw new RemovalDisabledError();
  }

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
  const authorOf = new Map(comments.map((comment) => [comment.id, comment.authorId]));

  if (!options.apply) {
    // Estimación para el informe: nada de esto autoriza un borrado.
    const blocked = new Set(
      await gateway.listCommentIdsWithReactionsFromOthers(
        comments.map((comment) => comment.id),
        batchIds,
      ),
    );
    const retained = new Set([...blocked].map((id) => authorOf.get(id)!));

    return {
      batchAccounts: batchIds.length,
      retainedAccounts: retained.size,
      removableComments: comments.length - blocked.size,
      blockedComments: blocked.size,
      deleted,
    };
  }

  // 1. Los Me gusta del propio lote salen primero: son datos del lote y, si quedaran, harían que
  //    sus comentarios parezcan «con reacciones».
  deleted.room_comment_reactions = await gateway.deleteRowsByUsers(
    'room_comment_reactions',
    batchIds,
  );

  // 2. Un único paso atómico: borra los comentarios sin ninguna reacción y omite el resto. Lo que
  //    llegue de otra persona, incluso en este instante, queda a salvo.
  const outcome = await gateway.deleteCommentsWithoutReactions(
    comments.map((comment) => comment.id),
  );
  deleted.room_comments = outcome.deleted.length;

  // 3. Quien conserva un comentario (con reacciones ajenas) se queda con su cuenta y su perfil.
  const retained = new Set(outcome.skipped.map((id) => authorOf.get(id)).filter((id) => !!id));
  const removableUsers = batchIds.filter((id) => !retained.has(id));

  deleted.match_reviews = await gateway.deleteRowsByUsers('match_reviews', removableUsers);
  deleted.match_ratings = await gateway.deleteRowsByUsers('match_ratings', removableUsers);
  deleted.watched_matches = await gateway.deleteRowsByUsers('watched_matches', removableUsers);
  deleted.profiles = await gateway.deleteRowsByUsers('profiles', removableUsers);

  for (const id of removableUsers) {
    await gateway.deleteAuthUser(id);
    deleted.auth_users += 1;
  }

  return {
    batchAccounts: batchIds.length,
    retainedAccounts: retained.size,
    removableComments: outcome.deleted.length,
    blockedComments: outcome.skipped.length,
    deleted,
  };
}

export interface MinimumCheck {
  /** `false` en una corrida limitada a propósito (`limit`): ahí no se exige el mínimo. */
  checked: boolean;
  reached: boolean;
  accountsWithProfile: number;
  target: number;
}

/**
 * ¿Terminó la carga con el mínimo de cuentas registradas con perfil? Una corrida completa que no lo
 * alcanza es un error, aunque ninguna cuenta haya fallado (por ejemplo, por un correo ajeno que
 * ocupaba un lugar). Una corrida limitada a propósito no se juzga.
 */
export function checkMinimum(snapshot: EnvironmentSnapshot, config: DemoSeedConfig): MinimumCheck {
  return {
    checked: config.limit === undefined,
    reached: snapshot.accountsWithProfile >= config.targetAccounts,
    accountsWithProfile: snapshot.accountsWithProfile,
    target: config.targetAccounts,
  };
}
