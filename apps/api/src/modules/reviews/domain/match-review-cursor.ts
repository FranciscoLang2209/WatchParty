import type { MatchReviewsCursor } from './match-review-store.js';

// Timestamp tal como lo devuelve Postgres/PostgREST para timestamptz (hasta 6
// decimales y zona horaria). Mismo patrón que CURSOR_TIMESTAMP_PATTERN en
// modules/comments; se define acá para no acoplar `reviews` a ese dominio. Se
// valida antes de que el store lo interpole en un filtro `.or(...)`.
const CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_TOKEN_MAX_LENGTH = 200;

/** `true` si el cursor tiene fecha y UUID con formato válido (WAT-256). */
export function isValidReviewsCursor(cursor: MatchReviewsCursor): boolean {
  return (
    CURSOR_TIMESTAMP_PATTERN.test(cursor.createdAt) &&
    !Number.isNaN(Date.parse(cursor.createdAt)) &&
    CURSOR_UUID_PATTERN.test(cursor.userId)
  );
}

/**
 * Cursor de `GET /matches/:matchId/reviews` como un único texto opaco
 * (base64url). Las reseñas se desempatan por `user_id`, que es un
 * identificador de cuenta: el cliente nunca lo recibe como campo suelto, solo
 * dentro de este token, que debe tratar como opaco y devolver tal cual.
 */
export function encodeReviewsCursor(cursor: MatchReviewsCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt, u: cursor.userId })).toString(
    'base64url',
  );
}

/** Inverso de `encodeReviewsCursor`; `null` si el texto no es un cursor válido. */
export function decodeReviewsCursor(token: string): MatchReviewsCursor | null {
  if (token.length > CURSOR_TOKEN_MAX_LENGTH || !CURSOR_TOKEN_PATTERN.test(token)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { c, u } = parsed as Record<string, unknown>;
  if (typeof c !== 'string' || typeof u !== 'string') return null;

  const cursor = { createdAt: c, userId: u };
  return isValidReviewsCursor(cursor) ? cursor : null;
}
