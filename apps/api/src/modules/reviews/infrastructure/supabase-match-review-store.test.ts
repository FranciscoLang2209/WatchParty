import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseMatchReviewStore } from './supabase-match-review-store.js';
import { MatchReviewPersistenceError } from './match-review-persistence-error.js';
import { ANONYMOUS_REVIEW_AUTHOR_NAME } from '../domain/match-review-store.js';

interface ReviewRow {
  user_id: string;
  match_id: string;
  body: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface FakeOptions {
  rows?: ReviewRow[];
  selectError?: { message: string };
  upsertError?: { message: string };
  deleteError?: { message: string };
  /** Tabla `profiles` en memoria (por defecto vacía: nadie tiene perfil). */
  profiles?: { user_id: string; display_name: unknown }[];
  listError?: { message: string };
  profilesError?: { message: string };
}

/** Lo que el trigger de la base pone en `updated_at` al reemplazar una fila. */
const NOW = '2026-11-02T10:00:00+00:00';

/**
 * Doble de Supabase con `match_reviews` en memoria: select filtra por ambas
 * columnas de la PK, como la base real, y solo devuelve las columnas pedidas.
 * upsert respeta la PK compuesta: reemplaza el texto en vez de duplicar la
 * fila, conserva `created_at` y mueve `updated_at` como el trigger.
 */
function makeFakeClient(options: FakeOptions = {}) {
  const rows = [...(options.rows ?? [])];
  const profileQueries: { columns: string; ids: string[] }[] = [];

  const from = vi.fn((table: string) => {
    if (table === 'profiles') {
      let columns = '';
      const profilesBuilder = {
        select: vi.fn((requested: string) => {
          columns = requested;
          return profilesBuilder;
        }),
        in: vi.fn((_column: string, ids: string[]) => {
          profileQueries.push({ columns, ids });
          return profilesBuilder;
        }),
        then: (resolve: (result: { data: unknown; error: unknown }) => unknown) => {
          const ids = profileQueries[profileQueries.length - 1]?.ids ?? [];
          const wanted = columns.split(',').map((c) => c.trim());
          const data = (options.profiles ?? [])
            .filter((p) => ids.includes(p.user_id))
            .map((p) => Object.fromEntries(wanted.map((c) => [c, p[c as keyof typeof p]])));
          return Promise.resolve(
            resolve(
              options.profilesError
                ? { data: null, error: options.profilesError }
                : { data, error: null },
            ),
          );
        },
      };
      return profilesBuilder;
    }

    if (table !== 'match_reviews') throw new Error(`Tabla inesperada: ${table}`);

    const filters: Record<string, string> = {};
    let columns = '';
    let orFilter: string | null = null;
    const orderings: { column: string; ascending: boolean }[] = [];
    let rowLimit = Infinity;
    let lastUpserted: ReviewRow | null = null;

    const pick = (row: ReviewRow) =>
      Object.fromEntries(
        columns.split(',').map((c) => [c.trim(), row[c.trim() as keyof ReviewRow]]),
      );

    const builder = {
      delete: vi.fn(() => {
        const deleteFilters: Record<string, string> = {};
        const deleteBuilder = {
          eq: vi.fn((column: string, value: string) => {
            deleteFilters[column] = value;
            return deleteBuilder;
          }),
          // Se espera (await) al final de la cadena, como el builder real.
          then: (resolve: (result: { error: { message: string } | null }) => unknown) => {
            if (!options.deleteError) {
              for (let i = rows.length - 1; i >= 0; i--) {
                if (
                  Object.entries(deleteFilters).every(
                    ([c, v]) => rows[i]![c as keyof ReviewRow] === v,
                  )
                ) {
                  rows.splice(i, 1);
                }
              }
            }
            return Promise.resolve(resolve({ error: options.deleteError ?? null }));
          },
        };
        return deleteBuilder;
      }),
      select: vi.fn((requested: string) => {
        columns = requested;
        return builder;
      }),
      eq: vi.fn((column: string, value: string) => {
        filters[column] = value;
        return builder;
      }),
      or: vi.fn((filter: string) => {
        orFilter = filter;
        return builder;
      }),
      order: vi.fn((column: string, { ascending }: { ascending: boolean }) => {
        orderings.push({ column, ascending });
        return builder;
      }),
      limit: vi.fn((count: number) => {
        rowLimit = count;
        return builder;
      }),
      // Listado: se espera (await) al final de la cadena, como el builder real.
      then: (resolve: (result: { data: unknown; error: unknown }) => unknown) => {
        if (options.listError) {
          return Promise.resolve(resolve({ data: null, error: options.listError }));
        }
        let result = rows.filter((r) =>
          Object.entries(filters).every(([c, v]) => r[c as keyof ReviewRow] === v),
        );
        if (orFilter !== null) {
          // Solo se entiende el filtro de keyset de WAT-256:
          // created_at.lt.X,and(created_at.eq.X,user_id.lt.U)
          const m = /^created_at\.lt\.(.+?),and\(created_at\.eq\.(.+?),user_id\.lt\.(.+)\)$/.exec(
            orFilter,
          );
          if (!m) throw new Error(`Filtro or inesperado: ${orFilter}`);
          const [, lt, eq, userLt] = m as unknown as [string, string, string, string];
          result = result.filter(
            (r) =>
              Date.parse(r.created_at as string) < Date.parse(lt) ||
              (r.created_at === eq && (r.user_id as string) < userLt),
          );
        }
        result = [...result].sort((a, b) => {
          for (const { column, ascending } of orderings) {
            const x = String(a[column as keyof ReviewRow]);
            const y = String(b[column as keyof ReviewRow]);
            if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        return Promise.resolve(resolve({ data: result.slice(0, rowLimit).map(pick), error: null }));
      },
      maybeSingle: vi.fn(async () => {
        if (options.selectError) return { data: null, error: options.selectError };
        const row = rows.find((r) =>
          Object.entries(filters).every(([c, v]) => r[c as keyof ReviewRow] === v),
        );
        return { data: row ? pick(row) : null, error: null };
      }),
      upsert: vi.fn((payload: Pick<ReviewRow, 'user_id' | 'match_id' | 'body'>) => {
        if (!options.upsertError) {
          const index = rows.findIndex(
            (r) => r.user_id === payload.user_id && r.match_id === payload.match_id,
          );
          const previous = index >= 0 ? rows[index] : undefined;
          const row: ReviewRow = {
            ...payload,
            created_at: previous?.created_at ?? NOW,
            updated_at: NOW,
          };
          if (index >= 0) rows[index] = row;
          else rows.push(row);
          lastUpserted = row;
        }
        return builder;
      }),
      single: vi.fn(async () => {
        if (options.upsertError) return { data: null, error: options.upsertError };
        return { data: lastUpserted ? pick(lastUpserted) : null, error: null };
      }),
    };
    return builder;
  });

  return { from, rows, profileQueries };
}

const asClient = (fake: ReturnType<typeof makeFakeClient>) => fake as unknown as SupabaseClient;

const MATCH_ID = 'a1111111-1111-4111-8111-111111111111';
const USER_ID = 'u1111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = 'u2222222-2222-4222-8222-222222222222';

const ROW: ReviewRow = {
  user_id: USER_ID,
  match_id: MATCH_ID,
  body: 'Gran partido',
  created_at: '2026-10-30T12:00:00+00:00',
  updated_at: '2026-10-31T09:30:00+00:00',
};

describe('SupabaseMatchReviewStore.findReview', () => {
  it('devuelve la reseña propia con sus fechas', async () => {
    const store = new SupabaseMatchReviewStore(asClient(makeFakeClient({ rows: [ROW] })));

    expect(await store.findReview(USER_ID, MATCH_ID)).toEqual({
      body: 'Gran partido',
      createdAt: '2026-10-30T12:00:00+00:00',
      updatedAt: '2026-10-31T09:30:00+00:00',
    });
  });

  it('devuelve null si el usuario no reseñó, aunque otro usuario sí lo haya hecho', async () => {
    const fake = makeFakeClient({ rows: [{ ...ROW, user_id: OTHER_USER_ID }] });

    expect(
      await new SupabaseMatchReviewStore(asClient(fake)).findReview(USER_ID, MATCH_ID),
    ).toBeNull();
  });

  it('filtra siempre por user_id y match_id, y no trae user_id', async () => {
    const fake = makeFakeClient();
    await new SupabaseMatchReviewStore(asClient(fake)).findReview(USER_ID, MATCH_ID);
    const builder = fake.from.mock.results[0]!.value as {
      eq: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
    };

    expect(builder.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(builder.eq).toHaveBeenCalledWith('match_id', MATCH_ID);
    expect(builder.select).toHaveBeenCalledWith('body, created_at, updated_at');
  });

  it('un fallo de lectura se lanza sanitizado, nunca se convierte en null', async () => {
    const fake = makeFakeClient({ selectError: { message: 'password=secreto host=db.interno' } });

    const error = await new SupabaseMatchReviewStore(asClient(fake))
      .findReview(USER_ID, MATCH_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchReviewPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
    expect((error as Error).message).not.toContain('db.interno');
  });

  it.each([
    ['body null', { body: null }],
    ['created_at ausente', { created_at: undefined }],
    ['updated_at numérico', { updated_at: 123 }],
  ])('una fila inválida en la base (%s) se trata como fallo de persistencia', async (_l, patch) => {
    const fake = makeFakeClient({ rows: [{ ...ROW, ...patch }] });

    await expect(
      new SupabaseMatchReviewStore(asClient(fake)).findReview(USER_ID, MATCH_ID),
    ).rejects.toBeInstanceOf(MatchReviewPersistenceError);
  });
});

describe('SupabaseMatchReviewStore.saveReview', () => {
  it('crea la reseña y devuelve la persistida con sus fechas', async () => {
    const fake = makeFakeClient();

    const review = await new SupabaseMatchReviewStore(asClient(fake)).saveReview(
      USER_ID,
      MATCH_ID,
      'Gran partido',
    );

    expect(review).toEqual({ body: 'Gran partido', createdAt: NOW, updatedAt: NOW });
    expect(fake.rows).toHaveLength(1);
  });

  it('editar reemplaza el texto sin duplicar la fila y conserva created_at', async () => {
    const fake = makeFakeClient({ rows: [ROW] });

    const review = await new SupabaseMatchReviewStore(asClient(fake)).saveReview(
      USER_ID,
      MATCH_ID,
      'Mejor de lo que recordaba',
    );

    expect(fake.rows).toHaveLength(1);
    expect(review).toEqual({
      body: 'Mejor de lo que recordaba',
      createdAt: ROW.created_at,
      updatedAt: NOW,
    });
  });

  it('no toca la reseña de otro usuario sobre el mismo partido', async () => {
    const other: ReviewRow = { ...ROW, user_id: OTHER_USER_ID, body: 'Aburrido' };
    const fake = makeFakeClient({ rows: [other] });

    await new SupabaseMatchReviewStore(asClient(fake)).saveReview(
      USER_ID,
      MATCH_ID,
      'Gran partido',
    );

    expect(fake.rows).toHaveLength(2);
    expect(fake.rows.find((r) => r.user_id === OTHER_USER_ID)?.body).toBe('Aburrido');
  });

  it('usa onConflict sobre la PK compuesta y escribe solo user_id, match_id y body', async () => {
    const fake = makeFakeClient();
    await new SupabaseMatchReviewStore(asClient(fake)).saveReview(
      USER_ID,
      MATCH_ID,
      'Gran partido',
    );
    const builder = fake.from.mock.results[0]!.value as {
      upsert: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
    };

    expect(builder.upsert).toHaveBeenCalledWith(
      { user_id: USER_ID, match_id: MATCH_ID, body: 'Gran partido' },
      { onConflict: 'user_id,match_id' },
    );
    expect(builder.select).toHaveBeenCalledWith('body, created_at, updated_at');
  });

  it.each([
    ['vacío', ''],
    ['solo espacios', '   '],
    ['con espacios exteriores', ' Gran partido '],
    ['501 caracteres', 'a'.repeat(501)],
    ['carácter nulo', 'hola\u0000chau'],
  ])('un texto no normalizado (%s) lanza RangeError y no escribe', async (_label, body) => {
    const fake = makeFakeClient();

    await expect(
      new SupabaseMatchReviewStore(asClient(fake)).saveReview(USER_ID, MATCH_ID, body),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fake.from).not.toHaveBeenCalled();
  });

  it('un fallo de escritura se lanza sanitizado como error de persistencia', async () => {
    const fake = makeFakeClient({ upsertError: { message: 'password=secreto host=db.interno' } });

    const error = await new SupabaseMatchReviewStore(asClient(fake))
      .saveReview(USER_ID, MATCH_ID, 'Gran partido')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchReviewPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
    expect((error as Error).message).not.toContain('db.interno');
  });
});

describe('SupabaseMatchReviewStore.deleteReview', () => {
  it('elimina la reseña propia y findReview ya no la devuelve', async () => {
    const fake = makeFakeClient({ rows: [ROW] });
    const store = new SupabaseMatchReviewStore(asClient(fake));

    await store.deleteReview(USER_ID, MATCH_ID);

    expect(fake.rows).toHaveLength(0);
    expect(await store.findReview(USER_ID, MATCH_ID)).toBeNull();
  });

  it('borrar de nuevo, sin reseña, no falla y no cambia nada', async () => {
    const fake = makeFakeClient({ rows: [ROW] });
    const store = new SupabaseMatchReviewStore(asClient(fake));

    await store.deleteReview(USER_ID, MATCH_ID);
    await expect(store.deleteReview(USER_ID, MATCH_ID)).resolves.toBeUndefined();

    expect(fake.rows).toHaveLength(0);
  });

  it('no toca la reseña de otro usuario ni la del mismo usuario en otro partido', async () => {
    const other: ReviewRow = { ...ROW, user_id: OTHER_USER_ID, body: 'Aburrido' };
    const otherMatch: ReviewRow = { ...ROW, match_id: 'a2222222-2222-4222-8222-222222222222' };
    const fake = makeFakeClient({ rows: [ROW, other, otherMatch] });

    await new SupabaseMatchReviewStore(asClient(fake)).deleteReview(USER_ID, MATCH_ID);

    expect(fake.rows).toEqual([other, otherMatch]);
  });

  it('filtra siempre por user_id y match_id', async () => {
    const fake = makeFakeClient({ rows: [ROW] });
    await new SupabaseMatchReviewStore(asClient(fake)).deleteReview(USER_ID, MATCH_ID);
    const builder = fake.from.mock.results[0]!.value as { delete: ReturnType<typeof vi.fn> };
    const deleteBuilder = builder.delete.mock.results[0]!.value as {
      eq: ReturnType<typeof vi.fn>;
    };

    expect(deleteBuilder.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(deleteBuilder.eq).toHaveBeenCalledWith('match_id', MATCH_ID);
  });

  it('un fallo de borrado se lanza sanitizado como error de persistencia', async () => {
    const fake = makeFakeClient({
      rows: [ROW],
      deleteError: { message: 'password=secreto host=db.interno' },
    });

    const error = await new SupabaseMatchReviewStore(asClient(fake))
      .deleteReview(USER_ID, MATCH_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchReviewPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
    expect((error as Error).message).not.toContain('db.interno');
    expect(fake.rows).toHaveLength(1);
  });
});

describe('SupabaseMatchReviewStore.listMatchReviews', () => {
  const U1 = 'c1111111-1111-4111-8111-111111111111';
  const U2 = 'c2222222-2222-4222-8222-222222222222';
  const U3 = 'c3333333-3333-4333-8333-333333333333';
  const OTHER_MATCH_ID = 'a2222222-2222-4222-8222-222222222222';

  const row = (
    userId: string,
    createdAt: string,
    body = `texto ${userId.slice(0, 2)}`,
  ): ReviewRow => ({
    user_id: userId,
    match_id: MATCH_ID,
    body,
    created_at: createdAt,
    updated_at: createdAt,
  });
  const store = (fake: ReturnType<typeof makeFakeClient>) =>
    new SupabaseMatchReviewStore(asClient(fake));

  it('lista de la más reciente a la más antigua, solo de ese partido, con el nombre del perfil', async () => {
    const fake = makeFakeClient({
      rows: [
        row(U1, '2026-11-01T10:00:00+00:00', 'vieja'),
        row(U2, '2026-11-03T10:00:00+00:00', 'nueva'),
        { ...row(U3, '2026-11-04T10:00:00+00:00', 'de otro partido'), match_id: OTHER_MATCH_ID },
      ],
      profiles: [
        { user_id: U1, display_name: 'Ana' },
        { user_id: U2, display_name: 'Beto' },
      ],
    });

    const page = await store(fake).listMatchReviews(MATCH_ID, { limit: 10 });

    expect(page).toEqual({
      items: [
        { authorName: 'Beto', body: 'nueva', createdAt: '2026-11-03T10:00:00+00:00' },
        { authorName: 'Ana', body: 'vieja', createdAt: '2026-11-01T10:00:00+00:00' },
      ],
      nextCursor: null,
    });
  });

  it('los items no llevan user_id, email ni nota', async () => {
    const fake = makeFakeClient({
      rows: [row(U1, '2026-11-01T10:00:00+00:00')],
      profiles: [{ user_id: U1, display_name: 'Ana' }],
    });

    const { items } = await store(fake).listMatchReviews(MATCH_ID, { limit: 10 });

    expect(Object.keys(items[0]!).sort()).toEqual(['authorName', 'body', 'createdAt']);
    expect(JSON.stringify(items)).not.toContain(U1);
  });

  it('consulta match_reviews por match_id y profiles solo con user_id y display_name', async () => {
    const fake = makeFakeClient({ rows: [row(U1, '2026-11-01T10:00:00+00:00')] });

    await store(fake).listMatchReviews(MATCH_ID, { limit: 10 });
    const reviews = fake.from.mock.results[0]!.value as {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
    };

    expect(reviews.select).toHaveBeenCalledWith('user_id, body, created_at');
    expect(reviews.eq).toHaveBeenCalledWith('match_id', MATCH_ID);
    expect(fake.profileQueries).toEqual([{ columns: 'user_id, display_name', ids: [U1] }]);
  });

  it.each([
    ['sin perfil', []],
    ['nombre vacío', [{ user_id: U1, display_name: '' }]],
    ['nombre de solo espacios', [{ user_id: U1, display_name: '   ' }]],
    ['nombre que no es texto', [{ user_id: U1, display_name: null }]],
  ])('autor con %s: usa la etiqueta neutra', async (_label, profiles) => {
    const fake = makeFakeClient({ rows: [row(U1, '2026-11-01T10:00:00+00:00')], profiles });

    const { items } = await store(fake).listMatchReviews(MATCH_ID, { limit: 10 });

    expect(items[0]!.authorName).toBe(ANONYMOUS_REVIEW_AUTHOR_NAME);
  });

  it('recorta los espacios exteriores del nombre visible', async () => {
    const fake = makeFakeClient({
      rows: [row(U1, '2026-11-01T10:00:00+00:00')],
      profiles: [{ user_id: U1, display_name: '  Ana  ' }],
    });

    expect((await store(fake).listMatchReviews(MATCH_ID, { limit: 10 })).items[0]!.authorName).toBe(
      'Ana',
    );
  });

  it('partido sin reseñas devuelve una página vacía y no consulta perfiles', async () => {
    const fake = makeFakeClient();

    expect(await store(fake).listMatchReviews(MATCH_ID, { limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fake.profileQueries).toEqual([]);
  });

  it('pide limit + 1 y devuelve el cursor de la última fila con su fecha cruda', async () => {
    const raw = '2026-11-02T10:00:00.123456+00:00';
    const fake = makeFakeClient({
      rows: [
        row(U1, '2026-11-01T10:00:00+00:00'),
        row(U2, raw),
        row(U3, '2026-11-03T10:00:00+00:00'),
      ],
    });

    const page = await store(fake).listMatchReviews(MATCH_ID, { limit: 2 });
    const reviews = fake.from.mock.results[0]!.value as { limit: ReturnType<typeof vi.fn> };

    expect(reviews.limit).toHaveBeenCalledWith(3);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual({ createdAt: raw, userId: U2 });
    expect(fake.profileQueries[0]!.ids).toEqual([U3, U2]);
  });

  it('con empates de created_at recorre todas las reseñas una sola vez, desempatando por user_id', async () => {
    const tie = '2026-11-01T10:00:00+00:00';
    const fake = makeFakeClient({ rows: [row(U1, tie), row(U2, tie), row(U3, tie)] });

    const bodies: string[] = [];
    let after: { createdAt: string; userId: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await store(fake).listMatchReviews(MATCH_ID, {
        limit: 1,
        ...(after && { after }),
      });
      bodies.push(...page.items.map((i) => i.body));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }

    expect(bodies).toEqual(['texto c3', 'texto c2', 'texto c1']);
  });

  it('aplica el cursor con el filtro de keyset sobre (created_at, user_id)', async () => {
    const fake = makeFakeClient({ rows: [] });
    const after = { createdAt: '2026-11-01T10:00:00.5+00:00', userId: U2 };

    await store(fake).listMatchReviews(MATCH_ID, { limit: 5, after });
    const reviews = fake.from.mock.results[0]!.value as {
      or: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
    };

    expect(reviews.or).toHaveBeenCalledWith(
      `created_at.lt.${after.createdAt},and(created_at.eq.${after.createdAt},user_id.lt.${U2})`,
    );
    expect(reviews.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false });
    expect(reviews.order).toHaveBeenNthCalledWith(2, 'user_id', { ascending: false });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'un limit inválido (%s) lanza RangeError y no consulta',
    async (limit) => {
      const fake = makeFakeClient();

      await expect(store(fake).listMatchReviews(MATCH_ID, { limit })).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(fake.from).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['fecha inválida', { createdAt: 'ayer', userId: U1 }],
    ['user que no es UUID', { createdAt: '2026-11-01T10:00:00+00:00', userId: 'x' }],
    [
      'intento de inyección en el filtro',
      { createdAt: '2026-11-01T10:00:00+00:00,id.gt.0', userId: U1 },
    ],
  ])('un cursor inválido (%s) lanza RangeError y no consulta', async (_label, after) => {
    const fake = makeFakeClient();

    await expect(
      store(fake).listMatchReviews(MATCH_ID, { limit: 5, after }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fake.from).not.toHaveBeenCalled();
  });

  it('un fallo al listar se lanza sanitizado, nunca como lista vacía', async () => {
    const fake = makeFakeClient({ listError: { message: 'password=secreto host=db.interno' } });

    const error = await store(fake)
      .listMatchReviews(MATCH_ID, { limit: 5 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchReviewPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
    expect((error as Error).message).not.toContain('db.interno');
  });

  it('un fallo al leer perfiles se lanza sanitizado y no se disfraza de etiqueta neutra', async () => {
    const fake = makeFakeClient({
      rows: [row(U1, '2026-11-01T10:00:00+00:00')],
      profilesError: { message: 'password=secreto host=db.interno' },
    });

    const error = await store(fake)
      .listMatchReviews(MATCH_ID, { limit: 5 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchReviewPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
  });

  it.each([
    ['body null', { body: null }],
    ['created_at ausente', { created_at: undefined }],
    ['user_id numérico', { user_id: 5 }],
  ])('una fila inválida en la base (%s) se trata como fallo de persistencia', async (_l, patch) => {
    const fake = makeFakeClient({
      rows: [{ ...row(U1, '2026-11-01T10:00:00+00:00'), ...patch } as ReviewRow],
    });

    await expect(store(fake).listMatchReviews(MATCH_ID, { limit: 5 })).rejects.toBeInstanceOf(
      MatchReviewPersistenceError,
    );
  });
});
