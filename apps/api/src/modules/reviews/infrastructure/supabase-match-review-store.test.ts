import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseMatchReviewStore } from './supabase-match-review-store.js';
import { MatchReviewPersistenceError } from './match-review-persistence-error.js';

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

  const from = vi.fn((table: string) => {
    if (table !== 'match_reviews') throw new Error(`Tabla inesperada: ${table}`);

    const filters: Record<string, string> = {};
    let columns = '';
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

  return { from, rows };
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
