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
}

/**
 * Doble de Supabase con `match_reviews` en memoria: select filtra por ambas
 * columnas de la PK, como la base real, y solo devuelve las columnas pedidas.
 */
function makeFakeClient(options: FakeOptions = {}) {
  const rows = [...(options.rows ?? [])];

  const from = vi.fn((table: string) => {
    if (table !== 'match_reviews') throw new Error(`Tabla inesperada: ${table}`);

    const filters: Record<string, string> = {};
    let columns = '';

    const builder = {
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
        if (!row) return { data: null, error: null };
        const picked = Object.fromEntries(
          columns.split(',').map((c) => [c.trim(), row[c.trim() as keyof ReviewRow]]),
        );
        return { data: picked, error: null };
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
