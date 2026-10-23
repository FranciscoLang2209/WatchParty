import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseMatchRatingStore } from './supabase-match-rating-store.js';
import { MatchRatingPersistenceError } from './match-rating-persistence-error.js';

interface RatingRow {
  user_id: string;
  match_id: string;
  rating: number;
}

type FakeError = { message: string };

interface FakeOptions {
  rows?: RatingRow[];
  selectError?: FakeError;
  upsertError?: FakeError;
  /** Valor que devuelve la base en `rating` (para simular datos corruptos). */
  returnedRating?: unknown;
}

/**
 * Doble de Supabase con `match_ratings` en memoria: upsert respeta la PK
 * compuesta (reemplaza la nota en vez de duplicar la fila) y select filtra
 * por ambas columnas, como la base real.
 */
function makeFakeClient(options: FakeOptions = {}) {
  const rows = [...(options.rows ?? [])];

  const from = vi.fn((table: string) => {
    if (table !== 'match_ratings') throw new Error(`Tabla inesperada: ${table}`);

    const filters: Record<string, string> = {};
    let lastUpserted: RatingRow | null = null;

    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: string) => {
        filters[column] = value;
        return builder;
      }),
      maybeSingle: vi.fn(async () => {
        if (options.selectError) return { data: null, error: options.selectError };
        const row = rows.find((r) =>
          Object.entries(filters).every(([c, v]) => r[c as keyof RatingRow] === v),
        );
        return { data: row ? { rating: options.returnedRating ?? row.rating } : null, error: null };
      }),
      upsert: vi.fn((row: RatingRow) => {
        if (!options.upsertError) {
          const index = rows.findIndex(
            (r) => r.user_id === row.user_id && r.match_id === row.match_id,
          );
          if (index >= 0) rows[index] = row;
          else rows.push(row);
          lastUpserted = row;
        }
        return builder;
      }),
      single: vi.fn(async () => {
        if (options.upsertError) return { data: null, error: options.upsertError };
        return { data: { rating: options.returnedRating ?? lastUpserted?.rating }, error: null };
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

describe('SupabaseMatchRatingStore.findRating', () => {
  it('devuelve la nota propia', async () => {
    const fake = makeFakeClient({ rows: [{ user_id: USER_ID, match_id: MATCH_ID, rating: 4 }] });
    const store = new SupabaseMatchRatingStore(asClient(fake));

    expect(await store.findRating(USER_ID, MATCH_ID)).toBe(4);
  });

  it('devuelve null si el usuario no calificó, aunque otro usuario sí lo haya hecho', async () => {
    const fake = makeFakeClient({
      rows: [{ user_id: OTHER_USER_ID, match_id: MATCH_ID, rating: 5 }],
    });
    const store = new SupabaseMatchRatingStore(asClient(fake));

    expect(await store.findRating(USER_ID, MATCH_ID)).toBeNull();
  });

  it('filtra siempre por user_id y match_id', async () => {
    const fake = makeFakeClient();
    await new SupabaseMatchRatingStore(asClient(fake)).findRating(USER_ID, MATCH_ID);
    const builder = fake.from.mock.results[0]!.value as { eq: ReturnType<typeof vi.fn> };

    expect(builder.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(builder.eq).toHaveBeenCalledWith('match_id', MATCH_ID);
  });

  it('un fallo de lectura se lanza sanitizado, nunca se convierte en null', async () => {
    const fake = makeFakeClient({ selectError: { message: 'password=secreto host=db.interno' } });
    const store = new SupabaseMatchRatingStore(asClient(fake));

    const error = await store.findRating(USER_ID, MATCH_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchRatingPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
    expect((error as Error).message).not.toContain('db.interno');
  });

  it('una nota inválida en la base se trata como fallo de persistencia', async () => {
    const fake = makeFakeClient({
      rows: [{ user_id: USER_ID, match_id: MATCH_ID, rating: 4 }],
      returnedRating: 9,
    });

    await expect(
      new SupabaseMatchRatingStore(asClient(fake)).findRating(USER_ID, MATCH_ID),
    ).rejects.toBeInstanceOf(MatchRatingPersistenceError);
  });
});

describe('SupabaseMatchRatingStore.saveRating', () => {
  it('crea la nota con la identidad recibida y devuelve la persistida', async () => {
    const fake = makeFakeClient();
    const store = new SupabaseMatchRatingStore(asClient(fake));

    expect(await store.saveRating(USER_ID, MATCH_ID, 3)).toBe(3);
    expect(fake.rows).toEqual([{ user_id: USER_ID, match_id: MATCH_ID, rating: 3 }]);
  });

  it('usa onConflict sobre la PK compuesta', async () => {
    const fake = makeFakeClient();
    await new SupabaseMatchRatingStore(asClient(fake)).saveRating(USER_ID, MATCH_ID, 3);
    const builder = fake.from.mock.results[0]!.value as { upsert: ReturnType<typeof vi.fn> };

    expect(builder.upsert).toHaveBeenCalledWith(
      { user_id: USER_ID, match_id: MATCH_ID, rating: 3 },
      { onConflict: 'user_id,match_id' },
    );
  });

  it('editar y repetir dejan una sola fila', async () => {
    const fake = makeFakeClient();
    const store = new SupabaseMatchRatingStore(asClient(fake));

    await store.saveRating(USER_ID, MATCH_ID, 3);
    await store.saveRating(USER_ID, MATCH_ID, 3);
    expect(await store.saveRating(USER_ID, MATCH_ID, 5)).toBe(5);

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.rating).toBe(5);
  });

  it('no toca la nota de otro usuario', async () => {
    const fake = makeFakeClient({
      rows: [{ user_id: OTHER_USER_ID, match_id: MATCH_ID, rating: 2 }],
    });

    await new SupabaseMatchRatingStore(asClient(fake)).saveRating(USER_ID, MATCH_ID, 5);

    expect(fake.rows).toHaveLength(2);
    expect(fake.rows.find((r) => r.user_id === OTHER_USER_ID)?.rating).toBe(2);
  });

  it.each([0, 6, -1, 3.5, Number.NaN, '4', null, undefined])(
    'rechaza %s con RangeError sin escribir',
    async (value) => {
      const fake = makeFakeClient();

      await expect(
        new SupabaseMatchRatingStore(asClient(fake)).saveRating(USER_ID, MATCH_ID, value as number),
      ).rejects.toBeInstanceOf(RangeError);
      expect(fake.from).not.toHaveBeenCalled();
    },
  );

  it('un fallo de escritura se lanza sanitizado', async () => {
    const fake = makeFakeClient({
      upsertError: { message: 'connection string postgres://u:pw@host' },
    });

    const error = await new SupabaseMatchRatingStore(asClient(fake))
      .saveRating(USER_ID, MATCH_ID, 4)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchRatingPersistenceError);
    expect((error as Error).message).not.toContain('postgres://');
  });
});

/** Doble de Supabase para la función SQL `match_rating_summary` (`client.rpc`). */
function makeRpcClient(result: { data?: unknown; error?: FakeError | null }) {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { rpc } as unknown as SupabaseClient & { rpc: typeof rpc };
}

describe('SupabaseMatchRatingStore.getSummary', () => {
  it('llama a match_rating_summary solo con el id del partido y mapea la fila', async () => {
    const client = makeRpcClient({ data: [{ rating_count: 3, rating_average: 3.67 }] });

    const summary = await new SupabaseMatchRatingStore(client).getSummary(MATCH_ID);

    expect(summary).toEqual({ average: 3.67, count: 3 });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('match_rating_summary', { p_match_id: MATCH_ID });
  });

  it('sin votos devuelve { average: null, count: 0 }', async () => {
    const client = makeRpcClient({ data: [{ rating_count: 0, rating_average: null }] });

    expect(await new SupabaseMatchRatingStore(client).getSummary(MATCH_ID)).toEqual({
      average: null,
      count: 0,
    });
  });

  it.each([1, 5])('acepta promedio en los extremos del rango (%s)', async (average) => {
    const client = makeRpcClient({ data: [{ rating_count: 2, rating_average: average }] });

    expect(await new SupabaseMatchRatingStore(client).getSummary(MATCH_ID)).toEqual({
      average,
      count: 2,
    });
  });

  it('un fallo de la base se lanza sanitizado, nunca se convierte en "sin votos"', async () => {
    const client = makeRpcClient({ error: { message: 'password=secreto host=db.interno' } });

    const error = await new SupabaseMatchRatingStore(client)
      .getSummary(MATCH_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchRatingPersistenceError);
    expect((error as Error).message).not.toContain('secreto');
  });

  it.each([
    ['data nulo', null],
    ['arreglo vacío', []],
    [
      'más de una fila',
      [
        { rating_count: 1, rating_average: 4 },
        { rating_count: 1, rating_average: 4 },
      ],
    ],
    ['fila vacía', [{}]],
    ['cuenta negativa', [{ rating_count: -1, rating_average: null }]],
    ['cuenta decimal', [{ rating_count: 1.5, rating_average: 4 }]],
    ['cuenta como texto', [{ rating_count: '3', rating_average: 4 }]],
    ['votos sin promedio', [{ rating_count: 2, rating_average: null }]],
    ['promedio con cero votos', [{ rating_count: 0, rating_average: 3 }]],
    ['promedio cero con cero votos', [{ rating_count: 0, rating_average: 0 }]],
    ['promedio menor a 1', [{ rating_count: 2, rating_average: 0.99 }]],
    ['promedio mayor a 5', [{ rating_count: 2, rating_average: 5.01 }]],
    ['promedio como texto', [{ rating_count: 2, rating_average: '4' }]],
  ])('resumen incoherente (%s) se rechaza como fallo de persistencia', async (_name, data) => {
    const client = makeRpcClient({ data });

    await expect(new SupabaseMatchRatingStore(client).getSummary(MATCH_ID)).rejects.toBeInstanceOf(
      MatchRatingPersistenceError,
    );
  });
});
