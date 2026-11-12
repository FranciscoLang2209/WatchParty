import { describe, expect, it } from 'vitest';
import type { RoomCommentReactionStore } from '../../comments/domain/room-comment-reaction-store.js';
import type { RoomCommentStore } from '../../comments/domain/room-comment-store.js';
import type { Match } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { OwnProfileStore } from '../../profiles/domain/own-profile-store.js';
import { MatchRatingService } from '../../ratings/application/match-rating-service.js';
import type { MatchRatingStore } from '../../ratings/domain/match-rating-store.js';
import { MatchReviewService } from '../../reviews/application/match-review-service.js';
import type { MatchReviewStore } from '../../reviews/domain/match-review-store.js';
import type { PublicRoomStore } from '../../rooms/domain/public-room-store.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import { ROOM_CONVERSATION, seedDemoActivity } from './demo-activity.js';
import {
  buildIdentity,
  deterministicUuid,
  MAX_UNIQUE_IDENTITIES,
  pickFavoriteTeamId,
} from './demo-identities.js';
import {
  COUNTED_TABLES,
  planAccounts,
  removeBatch,
  sanitizeReason,
  seedAccounts,
  takeSnapshot,
  type CountedTable,
  type DemoAuthUser,
  type DemoSeedConfig,
  type DemoSeedGateway,
  type MatchesFingerprint,
  type RowsByUserTable,
} from './demo-seed.js';

const BATCH = 'demo-501-v1';

// ---------------------------------------------------------------------------------------------
// Dobles en memoria
// ---------------------------------------------------------------------------------------------

class FakeGateway implements DemoSeedGateway {
  users: DemoAuthUser[] = [];
  profileIds = new Set<string>();
  comments: { id: string; authorId: string }[] = [];
  reactions: { commentId: string; userId: string }[] = [];
  rows: Record<RowsByUserTable | 'ratings_extra', Set<string>> = {
    room_comment_reactions: new Set(),
    match_reviews: new Set(),
    match_ratings: new Set(),
    watched_matches: new Set(),
    profiles: new Set(),
    ratings_extra: new Set(),
  };
  matches: MatchesFingerprint = {
    count: 5000,
    byStatus: { finished: 4900, scheduled: 100 },
    firstKickoff: '2024-06-14T19:00:00Z',
    lastKickoff: '2026-12-01T19:00:00Z',
    digest: 'abc123',
  };
  /** Cuentas del lote cuya creación falla, por posición de alta (se vacía al "arreglar" el fallo). */
  failCreateFor = new Set<number>();
  created = 0;
  nextId = 1;

  async listAuthUsers() {
    return this.users.map((user) => ({ ...user }));
  }

  async createAuthUser(input: { email: string; password: string; batchId: string }) {
    this.created += 1;
    if (this.failCreateFor.has(this.created)) {
      throw new Error(`Fallo al crear ${input.email}: respuesta inesperada`);
    }
    const id = `user-${this.nextId++}`;
    this.users.push({ id, email: input.email, isAnonymous: false, batchId: input.batchId });
    return id;
  }

  async deleteAuthUser(id: string) {
    this.users = this.users.filter((user) => user.id !== id);
  }

  async listProfileUserIds() {
    return [...this.profileIds];
  }

  async countRows(table: CountedTable) {
    if (table === 'profiles') return this.profileIds.size;
    if (table === 'room_comments') return this.comments.length;
    if (table === 'room_comment_reactions') return this.reactions.length;
    if (table === 'matches') return this.matches.count;
    return 0;
  }

  async matchesFingerprint() {
    return this.matches;
  }

  async deleteRowsByUsers(table: RowsByUserTable, userIds: string[]) {
    const ids = new Set(userIds);
    let removed = 0;

    if (table === 'profiles') {
      for (const id of userIds) if (this.profileIds.delete(id)) removed += 1;
    } else if (table === 'room_comment_reactions') {
      const before = this.reactions.length;
      this.reactions = this.reactions.filter((reaction) => !ids.has(reaction.userId));
      removed = before - this.reactions.length;
    }

    return removed;
  }

  async listCommentsByAuthors(authorIds: string[]) {
    return this.comments.filter((comment) => authorIds.includes(comment.authorId));
  }

  async listCommentIdsWithReactionsFromOthers(commentIds: string[], batchUserIds: string[]) {
    return commentIds.filter((id) =>
      this.reactions.some((r) => r.commentId === id && !batchUserIds.includes(r.userId)),
    );
  }

  async deleteComments(ids: string[]) {
    const before = this.comments.length;
    this.comments = this.comments.filter((comment) => !ids.includes(comment.id));
    return before - this.comments.length;
  }
}

class FakeProfiles implements OwnProfileStore {
  saved = new Map<string, { displayName: string; bio: string; favoriteTeamId: string | null }>();
  failProfileFor = new Set<string>();
  constructor(
    private readonly gateway: FakeGateway,
    private readonly teamIds: string[],
  ) {}

  async getOwnProfile(userId: string) {
    return this.saved.get(userId) ?? null;
  }

  async saveOwnProfile(
    userId: string,
    input: { displayName: string; bio: string; favoriteTeamId: string | null },
  ) {
    if (this.failProfileFor.has(userId)) throw new Error('Fallo de base al guardar el perfil');
    this.saved.set(userId, input);
    this.gateway.profileIds.add(userId);
    return input;
  }

  async listTeams() {
    return this.teamIds.map((id) => ({ id, name: `Equipo ${id}` }));
  }
}

function config(overrides: Partial<DemoSeedConfig> = {}): DemoSeedConfig {
  return {
    batchId: BATCH,
    targetAccounts: 501,
    emailDomain: 'demo.watchparty.local',
    demoAccounts: [
      {
        email: 'cuenta.a@demo.watchparty.local',
        password: 'clave-a-secreta-1',
        displayName: 'Valentina Ríos',
        bio: 'Cuenta de demostración A.',
      },
      {
        email: 'cuenta.b@demo.watchparty.local',
        password: 'clave-b-secreta-2',
        displayName: 'Mateo Sosa',
        bio: 'Cuenta de demostración B.',
      },
    ],
    ...overrides,
  };
}

const TEAMS = Array.from({ length: 40 }, (_, index) => `team-${index + 1}`);

function entorno(preexistentes = 0) {
  const gateway = new FakeGateway();
  const profiles = new FakeProfiles(gateway, TEAMS);

  for (let index = 0; index < preexistentes; index += 1) {
    const id = `real-${index}`;
    gateway.users.push({
      id,
      email: `persona${index}@real.test`,
      isAnonymous: false,
      batchId: null,
    });
    gateway.profileIds.add(id);
  }

  return { gateway, profiles };
}

async function correr(env: ReturnType<typeof entorno>, cfg: DemoSeedConfig = config()) {
  const snapshot = await takeSnapshot(env.gateway, cfg.batchId);
  const plan = planAccounts(snapshot, cfg);
  const result = await seedAccounts({ gateway: env.gateway, profiles: env.profiles }, cfg, plan);

  return { plan, result, after: await takeSnapshot(env.gateway, cfg.batchId) };
}

// ---------------------------------------------------------------------------------------------

describe('identidades sintéticas', () => {
  it('son únicas y estables: la misma posición da siempre la misma persona', () => {
    const nombres = new Set<string>();
    const correos = new Set<string>();

    for (let index = 1; index <= 1000; index += 1) {
      const identidad = buildIdentity(index);
      nombres.add(identidad.displayName);
      correos.add(identidad.emailLocalPart);
      expect(buildIdentity(index)).toEqual(identidad);
    }

    expect(nombres.size).toBe(1000);
    expect(correos.size).toBe(1000);
    expect(MAX_UNIQUE_IDENTITIES).toBeGreaterThanOrEqual(1000);
  });

  it('parecen personas: nombre y apellido, sin patrones tipo Usuario_001, y cumplen los límites del perfil', () => {
    for (let index = 1; index <= 501; index += 1) {
      const { displayName, bio, emailLocalPart } = buildIdentity(index);

      expect(displayName).toMatch(/^\S+ \S+$/);
      expect(displayName).not.toMatch(/usuario|user|demo|test|prueba|\d/i);
      expect(displayName.length).toBeLessThanOrEqual(50);
      expect(bio.length).toBeLessThanOrEqual(280);
      expect(emailLocalPart).toMatch(/^[a-z]+\.[a-z]+\.\d{3}$/);
    }
  });

  it('rechaza posiciones fuera de rango', () => {
    expect(() => buildIdentity(0)).toThrow(RangeError);
    expect(() => buildIdentity(MAX_UNIQUE_IDENTITIES + 1)).toThrow(RangeError);
  });

  it('reparte los equipos favoritos y no inventa uno si no hay equipos', () => {
    const muestra = new Set(Array.from({ length: 10 }, (_, i) => pickFavoriteTeamId(i + 1, TEAMS)));

    expect(muestra.size).toBeGreaterThanOrEqual(8);
    expect(pickFavoriteTeamId(5, [])).toBeNull();
  });

  it('la clave de idempotencia es un UUID determinista', () => {
    const uuid = deterministicUuid('lote', 'partido', 'comentario-0');

    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid('lote', 'partido', 'comentario-0')).toBe(uuid);
    expect(deterministicUuid('lote', 'partido', 'comentario-1')).not.toBe(uuid);
  });
});

describe('cuentas y perfiles', () => {
  it('llega a 501 cuentas registradas distintas, cada una con su perfil, desde un entorno vacío', async () => {
    const env = entorno();
    const { plan, result, after } = await correr(env);

    expect(plan).toMatchObject({ existingOutsideBatch: 0, needed: 501, bulkTarget: 499 });
    expect(result.failures).toEqual([]);
    expect(after.registeredAccounts).toBe(501);
    expect(after.accountsWithProfile).toBe(501);
    expect(after.strayProfiles).toBe(0);
    expect(after.batchAccounts).toBe(501);
    expect(new Set(env.gateway.users.map((user) => user.email)).size).toBe(501);
    expect(result.demoUserIds.every((id) => id !== null)).toBe(true);
  });

  it('crea sólo las necesarias cuando el entorno ya tiene cuentas con perfil', async () => {
    const env = entorno(490);
    const { plan, after } = await correr(env);

    expect(plan).toMatchObject({ existingOutsideBatch: 490, needed: 11, bulkTarget: 9 });
    expect(env.gateway.created).toBe(11);
    expect(after.accountsWithProfile).toBe(501);
  });

  it('con más de 501 ya existentes sólo agrega las dos de demostración', async () => {
    const env = entorno(520);
    const { plan, after } = await correr(env);

    expect(plan.bulkTarget).toBe(0);
    expect(env.gateway.created).toBe(2);
    expect(after.batchAccounts).toBe(2);
  });

  it('repetir la carga no duplica cuentas ni perfiles', async () => {
    const env = entorno();
    const primera = await correr(env);
    const segunda = await correr(env);

    expect(primera.result.createdAccounts).toBe(501);
    expect(segunda.result).toMatchObject({
      createdAccounts: 0,
      createdProfiles: 0,
      existingAccounts: 501,
      failures: [],
    });
    expect(segunda.after.registeredAccounts).toBe(501);
    expect(segunda.after.profiles).toBe(501);
    expect(env.gateway.users).toHaveLength(501);
  });

  it('un fallo parcial no frena al resto y la siguiente corrida retoma lo que faltó', async () => {
    const env = entorno();
    env.gateway.failCreateFor = new Set([5, 77, 300]);

    const primera = await correr(env);

    expect(primera.result.failures).toHaveLength(3);
    expect(primera.after.accountsWithProfile).toBe(498);

    env.gateway.failCreateFor = new Set();
    const segunda = await correr(env);

    expect(segunda.result.createdAccounts).toBe(3);
    expect(segunda.after.accountsWithProfile).toBe(501);
    expect(env.gateway.users).toHaveLength(501);
  });

  it('una cuenta que quedó sin perfil se completa sin crear otra', async () => {
    const env = entorno();
    await correr(env);
    const huerfana = env.gateway.users[10]!;
    env.gateway.profileIds.delete(huerfana.id);
    env.profiles.saved.delete(huerfana.id);

    const resultado = await correr(env);

    expect(resultado.result).toMatchObject({ createdAccounts: 0, createdProfiles: 1 });
    expect(resultado.after.accountsWithProfile).toBe(501);
    expect(env.gateway.users).toHaveLength(501);
  });

  it('no pisa un perfil que ya existe', async () => {
    const env = entorno();
    await correr(env);
    const usuario = env.gateway.users[3]!;
    env.profiles.saved.set(usuario.id, {
      displayName: 'Nombre Editado',
      bio: 'x',
      favoriteTeamId: null,
    });

    await correr(env);

    expect(env.profiles.saved.get(usuario.id)?.displayName).toBe('Nombre Editado');
  });

  it('no toca un correo que ya es de otra persona', async () => {
    const env = entorno();
    const demoA = config().demoAccounts[0].email;
    env.gateway.users.push({ id: 'ajena', email: demoA, isAnonymous: false, batchId: null });

    const { result } = await correr(env);

    expect(result.conflicts).toBe(1);
    expect(env.profiles.saved.has('ajena')).toBe(false);
    expect(env.gateway.users.find((user) => user.id === 'ajena')?.batchId).toBeNull();
  });

  it('un lote chico crea sólo esa cantidad y la siguiente corrida sigue desde ahí', async () => {
    const env = entorno();
    const chico = await correr(env, config({ limit: 10 }));

    expect(chico.result.createdAccounts).toBe(12);
    expect(chico.after.accountsWithProfile).toBe(12);

    const completo = await correr(env);

    expect(completo.result.createdAccounts).toBe(489);
    expect(completo.after.accountsWithProfile).toBe(501);
  });

  it('cuenta sólo cuentas registradas: ni anónimos ni perfiles sueltos suman', async () => {
    const env = entorno();
    env.gateway.users.push({ id: 'anon', email: null, isAnonymous: true, batchId: null });
    env.gateway.profileIds.add('perfil-suelto');

    const snapshot = await takeSnapshot(env.gateway, BATCH);

    expect(snapshot).toMatchObject({
      registeredAccounts: 0,
      anonymousUsers: 1,
      strayProfiles: 1,
      accountsWithProfile: 0,
    });
  });

  it('informa los conteos por tabla principal y la huella de partidos, sin tocarlos', async () => {
    const env = entorno();
    const antes = await takeSnapshot(env.gateway, BATCH);
    const { after } = await correr(env);

    expect(Object.keys(after.tables).sort()).toEqual([...COUNTED_TABLES].sort());
    expect(after.matches).toEqual(antes.matches);
    expect(after.tables.matches).toBe(antes.tables.matches);
  });

  it('los fallos no incluyen correos ni contraseñas', async () => {
    const env = entorno();
    env.gateway.failCreateFor = new Set([1, 2]);

    const { result } = await correr(env);
    const texto = JSON.stringify(result);

    expect(texto).not.toContain('@');
    expect(texto).not.toContain('clave-a-secreta-1');
    expect(texto).not.toContain('clave-b-secreta-2');
    expect(sanitizeReason(new Error('error con persona@ejemplo.com adentro'))).toBe(
      'error con [correo] adentro',
    );
  });

  it('las cuentas masivas reciben una clave aleatoria distinta cada una', async () => {
    const claves: string[] = [];
    const env = entorno();
    const original = env.gateway.createAuthUser.bind(env.gateway);
    env.gateway.createAuthUser = async (input) => {
      claves.push(input.password);
      return original(input);
    };

    await correr(env, config({ limit: 20 }));

    const masivas = claves.filter((clave) => !clave.startsWith('clave-'));
    expect(masivas.length).toBeGreaterThanOrEqual(20);
    expect(new Set(masivas).size).toBe(masivas.length);
    expect(masivas.every((clave) => clave.length >= 32)).toBe(true);
  });
});

describe('retirada selectiva del lote', () => {
  it('sin apply no borra nada: informa lo que haría', async () => {
    const env = entorno(5);
    await correr(env, config({ limit: 8 }));
    const antes = env.gateway.users.length;

    const resultado = await removeBatch(env.gateway, BATCH, { apply: false });

    expect(resultado.batchAccounts).toBe(10);
    expect(resultado.deleted.auth_users).toBe(0);
    expect(env.gateway.users).toHaveLength(antes);
  });

  it('borra sólo cuentas y perfiles del lote y deja intactas las ajenas', async () => {
    const env = entorno(5);
    await correr(env, config({ limit: 8 }));

    const resultado = await removeBatch(env.gateway, BATCH, { apply: true });

    expect(resultado.deleted).toMatchObject({ auth_users: 10, profiles: 10 });
    expect(env.gateway.users.every((user) => user.batchId === null)).toBe(true);
    expect(env.gateway.users).toHaveLength(5);
    expect([...env.gateway.profileIds].sort()).toEqual(
      env.gateway.users.map((user) => user.id).sort(),
    );
    expect((await takeSnapshot(env.gateway, BATCH)).matches.digest).toBe('abc123');
  });

  it('conserva a quien tiene un comentario con Me gusta de otra persona y lo informa', async () => {
    const env = entorno(2);
    await correr(env, config({ limit: 3 }));
    const [a, b] = env.gateway.users.filter((user) => user.batchId === BATCH);
    env.gateway.comments.push(
      { id: 'c-ajeno-reaccionado', authorId: a!.id },
      { id: 'c-propio', authorId: b!.id },
    );
    env.gateway.reactions.push(
      { commentId: 'c-ajeno-reaccionado', userId: 'real-0' },
      { commentId: 'c-propio', userId: a!.id },
    );

    const resultado = await removeBatch(env.gateway, BATCH, { apply: true });

    expect(resultado).toMatchObject({ retainedAccounts: 1, blockedComments: 1 });
    expect(env.gateway.comments.map((comment) => comment.id)).toEqual(['c-ajeno-reaccionado']);
    expect(env.gateway.reactions).toEqual([{ commentId: 'c-ajeno-reaccionado', userId: 'real-0' }]);
    expect(env.gateway.users.some((user) => user.id === a!.id)).toBe(true);
    expect(env.gateway.profileIds.has(a!.id)).toBe(true);
  });

  it('un lote vacío no hace nada', async () => {
    const env = entorno(3);

    expect(await removeBatch(env.gateway, BATCH, { apply: true })).toMatchObject({
      batchAccounts: 0,
    });
    expect(env.gateway.users).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Actividad de las cuentas de demostración
// ---------------------------------------------------------------------------------------------

const unused = (): never => {
  throw new Error('no se usa en esta prueba');
};

function entornoActividad(matches: Match[]) {
  const comments: {
    id: string;
    roomId: string;
    authorId: string;
    requestId: string;
    body: string;
  }[] = [];
  const reactions = new Set<string>();
  const watched = new Set<string>();
  const ratings = new Map<string, number>();
  const reviews = new Map<string, string>();
  const rooms = new Map<string, string>();

  const catalog: MatchCatalog = {
    list: unused,
    findById: async (id) => matches.find((match) => match.id === id) ?? null,
  };
  const roomStore: PublicRoomStore = {
    getOrCreatePublicRoom: async (matchId) => {
      if (!matches.some((match) => match.id === matchId)) return null;
      if (!rooms.has(matchId)) rooms.set(matchId, `room-${matchId}`);
      return { id: rooms.get(matchId)!, matchId, createdAt: '2026-11-12T00:00:00Z' };
    },
    findPublicRoomById: unused,
  };
  const commentStore: RoomCommentStore = {
    listByRoom: unused,
    listPageByRoom: unused,
    create: async (input, authorId) => {
      const existing = comments.find(
        (comment) => comment.authorId === authorId && comment.requestId === input.clientRequestId,
      );
      if (existing)
        return { id: existing.id, roomId: existing.roomId, body: existing.body, createdAt: 'x' };
      const created = {
        id: `comment-${comments.length + 1}`,
        roomId: input.roomId,
        authorId,
        requestId: input.clientRequestId,
        body: input.body,
      };
      comments.push(created);
      return { id: created.id, roomId: created.roomId, body: created.body, createdAt: 'x' };
    },
  };
  const reactionStore: RoomCommentReactionStore = {
    getReaction: unused,
    setReaction: async ({ commentId, userId, reacted }) => {
      if (reacted) reactions.add(`${commentId}|${userId}`);
      else reactions.delete(`${commentId}|${userId}`);
      return { count: 1, reacted };
    },
  };
  const watchedStore: WatchedMatchStore = {
    setWatched: async (userId, matchId, value) => {
      if (value) watched.add(`${userId}|${matchId}`);
      else watched.delete(`${userId}|${matchId}`);
      return { matchId, watched: value };
    },
    getWatched: async (userId, matchId) => ({
      matchId,
      watched: watched.has(`${userId}|${matchId}`),
    }),
    listHistoryPage: unused,
  };
  const ratingStore: MatchRatingStore = {
    findRating: async (userId, matchId) => ratings.get(`${userId}|${matchId}`) ?? null,
    saveRating: async (userId, matchId, rating) => {
      ratings.set(`${userId}|${matchId}`, rating);
      return rating;
    },
    getSummary: unused,
  };
  const reviewStore: MatchReviewStore = {
    findReview: async (userId, matchId) => {
      const body = reviews.get(`${userId}|${matchId}`);
      return body === undefined ? null : { body, createdAt: 'x', updatedAt: 'x' };
    },
    saveReview: async (userId, matchId, body) => {
      reviews.set(`${userId}|${matchId}`, body);
      return { body, createdAt: 'x', updatedAt: 'x' };
    },
    deleteReview: unused,
    listMatchReviews: unused,
  };

  return {
    comments,
    reactions,
    watched,
    ratings,
    reviews,
    rooms,
    deps: {
      catalog,
      rooms: roomStore,
      comments: commentStore,
      reactions: reactionStore,
      watched: watchedStore,
      ratings: new MatchRatingService(catalog, watchedStore, ratingStore),
      reviews: new MatchReviewService(catalog, watchedStore, ratingStore, reviewStore),
    },
  };
}

const partido = (id: string, status: Match['status']): Match => ({
  id,
  homeTeam: 'Local',
  homeTeamId: 'team-1',
  awayTeam: 'Visita',
  awayTeamId: 'team-2',
  kickoffAt: '2025-03-01T20:00:00Z',
  status,
  score: null,
});

describe('actividad de las cuentas de demostración', () => {
  const usuarios = ['user-a', 'user-b'] as const;

  it('siembra sala, comentarios, reacciones cruzadas, visto, nota y reseña en un partido terminado', async () => {
    const env = entornoActividad([partido('m1', 'finished')]);

    const resultado = await seedDemoActivity(env.deps, BATCH, usuarios, ['m1']);

    expect(resultado.failures).toEqual([]);
    expect(resultado.matches).toEqual([{ matchId: 'm1', roomId: 'room-m1', comments: 6 }]);
    // Cada cuenta escribe la mitad de la conversación.
    expect(env.comments.filter((c) => c.authorId === 'user-a')).toHaveLength(3);
    expect(env.comments.filter((c) => c.authorId === 'user-b')).toHaveLength(3);
    // Las reacciones son de una cuenta sobre comentarios de la otra, nunca sobre los propios.
    for (const clave of env.reactions) {
      const [commentId, userId] = clave.split('|');
      expect(env.comments.find((c) => c.id === commentId)?.authorId).not.toBe(userId);
    }
    expect(env.reactions.size).toBe(4);
    expect(env.watched).toEqual(new Set(['user-a|m1', 'user-b|m1']));
    expect(env.ratings.get('user-a|m1')).toBe(4);
    expect(env.ratings.get('user-b|m1')).toBe(5);
    expect(env.reviews.size).toBe(2);
  });

  it('repetirla no duplica comentarios, reacciones, vistos, notas ni reseñas', async () => {
    const env = entornoActividad([partido('m1', 'finished'), partido('m2', 'finished')]);

    await seedDemoActivity(env.deps, BATCH, usuarios, ['m1', 'm2']);
    const antes = [
      env.comments.length,
      env.reactions.size,
      env.watched.size,
      env.ratings.size,
      env.reviews.size,
    ];
    await seedDemoActivity(env.deps, BATCH, usuarios, ['m1', 'm2']);

    expect([
      env.comments.length,
      env.reactions.size,
      env.watched.size,
      env.ratings.size,
      env.reviews.size,
    ]).toEqual(antes);
    expect(antes).toEqual([12, 8, 4, 4, 4]);
  });

  it('un partido que no está terminado no recibe nota ni reseña y no se le cambia el estado', async () => {
    const env = entornoActividad([partido('m-prog', 'scheduled')]);

    const resultado = await seedDemoActivity(env.deps, BATCH, usuarios, ['m-prog']);

    expect(resultado.matches).toEqual([]);
    expect(resultado.failures[0]).toContain('no está finalizado');
    expect(env.ratings.size + env.reviews.size + env.comments.length).toBe(0);
  });

  it('un partido inexistente se informa sin escribir nada', async () => {
    const env = entornoActividad([]);

    const resultado = await seedDemoActivity(env.deps, BATCH, usuarios, ['no-existe']);

    expect(resultado.failures).toEqual(['El partido no-existe no existe.']);
    expect(env.comments).toHaveLength(0);
  });

  it('pide entre uno y tres partidos', async () => {
    const env = entornoActividad([partido('m1', 'finished')]);

    expect((await seedDemoActivity(env.deps, BATCH, usuarios, [])).failures).toHaveLength(1);
    expect(
      (await seedDemoActivity(env.deps, BATCH, usuarios, ['a', 'b', 'c', 'd'])).failures,
    ).toHaveLength(1);
  });

  it('los textos no afirman hechos del partido ni exceden los límites', () => {
    for (const texto of ROOM_CONVERSATION) {
      expect([...texto].length).toBeLessThanOrEqual(180);
      expect(texto).not.toMatch(/\bgol\b|penal|expuls|empat|ganó|perdió|\d\s*-\s*\d/i);
    }
  });
});
