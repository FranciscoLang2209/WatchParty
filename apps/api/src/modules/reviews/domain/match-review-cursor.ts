import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MatchReviewsCursor } from './match-review-store.js';

// Timestamp tal como lo devuelve Postgres/PostgREST para timestamptz (hasta 6
// decimales y zona horaria). Mismo patrón que CURSOR_TIMESTAMP_PATTERN en
// modules/comments; se define acá para no acoplar `reviews` a ese dominio. Se
// valida antes de que el store lo interpole en un filtro `.or(...)`.
const CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_TOKEN_MAX_LENGTH = 300;

/** `true` si el cursor tiene fecha y UUID con formato válido (WAT-256). */
export function isValidReviewsCursor(cursor: MatchReviewsCursor): boolean {
  return (
    CURSOR_TIMESTAMP_PATTERN.test(cursor.createdAt) &&
    !Number.isNaN(Date.parse(cursor.createdAt)) &&
    CURSOR_UUID_PATTERN.test(cursor.userId)
  );
}

/**
 * Mínimo de caracteres de `REVIEWS_CURSOR_SECRET`. La clave de AES se deriva
 * con SHA-256, así que el largo no es un requisito técnico; el mínimo evita
 * un secreto trivial.
 */
export const REVIEWS_CURSOR_SECRET_MIN_LENGTH = 32;

const IV_BYTES = 12;
const TAG_BYTES = 16;
// Datos autenticados: ata el token a este uso, así un texto cifrado con la
// misma clave para otra cosa no se acepta como cursor de reseñas.
const AAD = Buffer.from('watchparty:reviews-cursor:v1');

/** Cursor de `GET /matches/:matchId/reviews`: texto opaco, cifrado. */
export interface ReviewsCursorCodec {
  encode(cursor: MatchReviewsCursor): string;
  /** `null` si el texto no es un cursor válido, o no se puede descifrar con la clave. */
  decode(token: string): MatchReviewsCursor | null;
}

/**
 * Cursor como un único texto opaco, CIFRADO con AES-256-GCM (WAT-256). Las
 * reseñas se desempatan por `user_id`, que es un identificador de cuenta:
 * base64 solo lo codificaría, y con `limit=1` cualquier usuario autenticado
 * podría juntar los ids de todos los autores. Cifrado y autenticado con una
 * clave del servidor, el cliente no puede leerlo ni fabricarlo.
 *
 * Formato: base64url(iv[12] | tag[16] | cifrado del JSON `{c,u}`), con IV
 * aleatorio por token (el mismo cursor produce textos distintos). Un token
 * alterado, de otra clave o mal formado no descifra y se rechaza como `null`.
 * Si se rota el secreto, los cursores en vuelo dejan de valer (400).
 */
export function createReviewsCursorCodec(secret: string): ReviewsCursorCodec {
  if (secret.length < REVIEWS_CURSOR_SECRET_MIN_LENGTH) {
    throw new Error(
      `REVIEWS_CURSOR_SECRET debe tener al menos ${REVIEWS_CURSOR_SECRET_MIN_LENGTH} caracteres.`,
    );
  }

  const key = createHash('sha256').update(secret).digest();

  return {
    encode(cursor) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ c: cursor.createdAt, u: cursor.userId }), 'utf8'),
        cipher.final(),
      ]);

      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },

    decode(token) {
      if (token.length > CURSOR_TOKEN_MAX_LENGTH || !CURSOR_TOKEN_PATTERN.test(token)) return null;

      const raw = Buffer.from(token, 'base64url');
      if (raw.length <= IV_BYTES + TAG_BYTES) return null;

      let parsed: unknown;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
        decipher.setAAD(AAD);
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const plain = Buffer.concat([
          decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]);
        parsed = JSON.parse(plain.toString('utf8'));
      } catch {
        return null;
      }

      if (typeof parsed !== 'object' || parsed === null) return null;
      const { c, u } = parsed as Record<string, unknown>;
      if (typeof c !== 'string' || typeof u !== 'string') return null;

      const cursor = { createdAt: c, userId: u };
      return isValidReviewsCursor(cursor) ? cursor : null;
    },
  };
}
