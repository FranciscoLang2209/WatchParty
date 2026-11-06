import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  createReviewsCursorCodec,
  REVIEWS_CURSOR_SECRET_MIN_LENGTH,
} from './match-review-cursor.js';

const SECRET = 'secreto-de-prueba-con-32-caracteres!!';
const codec = createReviewsCursorCodec(SECRET);

const CURSOR = {
  createdAt: '2026-11-01T10:00:00.123456+00:00',
  userId: 'b2222222-2222-4222-8222-222222222222',
};

/**
 * Cifra un payload arbitrario como lo haría el servidor (misma clave y mismos
 * datos autenticados), para probar que un token auténtico pero con contenido
 * inválido también se rechaza. `aad: false` simula un cifrado ajeno al cursor.
 */
function forge(payload: unknown, { aad = true }: { aad?: boolean } = {}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  if (aad) cipher.setAAD(Buffer.from('watchparty:reviews-cursor:v1'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

describe('cursor de reseñas', () => {
  it('codifica y decodifica sin perder datos, incluidos los microsegundos', () => {
    expect(codec.decode(codec.encode(CURSOR))).toEqual(CURSOR);
  });

  it('es un único texto opaco, apto para query string', () => {
    expect(codec.encode(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('no deja ver el user_id ni la fecha: decodificar el base64url no revela nada legible', () => {
    const token = codec.encode(CURSOR);
    const plain = Buffer.from(token, 'base64url').toString('latin1');

    expect(token).not.toContain(CURSOR.userId);
    expect(plain).not.toContain(CURSOR.userId);
    expect(plain).not.toContain('b2222222');
    expect(plain).not.toContain('2026-11-01');
    expect(() => JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))).toThrow();
  });

  it('el mismo cursor produce textos distintos (IV aleatorio) que decodifican igual', () => {
    const a = codec.encode(CURSOR);
    const b = codec.encode(CURSOR);

    expect(a).not.toBe(b);
    expect(codec.decode(a)).toEqual(codec.decode(b));
  });

  it('un token propio pasa por el mismo camino que uno forjado con la clave correcta', () => {
    expect(codec.decode(forge({ c: CURSOR.createdAt, u: CURSOR.userId }))).toEqual(CURSOR);
  });

  it('un cursor cifrado con otra clave no se puede descifrar', () => {
    const other = createReviewsCursorCodec('otro-secreto-distinto-de-32-caracteres');

    expect(codec.decode(other.encode(CURSOR))).toBeNull();
  });

  it('un token alterado se rechaza (GCM autentica)', () => {
    const raw = Buffer.from(codec.encode(CURSOR), 'base64url');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01;

    expect(codec.decode(raw.toString('base64url'))).toBeNull();
  });

  it('un cursor viejo en base64url con el user_id en claro ya no se acepta', () => {
    const legacy = Buffer.from(JSON.stringify({ c: CURSOR.createdAt, u: CURSOR.userId }));

    expect(codec.decode(legacy.toString('base64url'))).toBeNull();
  });

  it('un cifrado con la misma clave pero fuera del uso de cursor (sin sus datos autenticados) se rechaza', () => {
    expect(
      codec.decode(forge({ c: CURSOR.createdAt, u: CURSOR.userId }, { aad: false })),
    ).toBeNull();
  });

  it.each([
    ['vacío', ''],
    ['no es base64url', '%%%'],
    ['demasiado corto', 'abc'],
    ['texto cualquiera', 'hola'],
    ['un user_id suelto', CURSOR.userId],
    ['demasiado largo', 'a'.repeat(301)],
  ])('rechaza un cursor inválido (%s)', (_label, value) => {
    expect(codec.decode(value)).toBeNull();
  });

  it.each([
    ['JSON que no es objeto', 'hola'],
    ['null', null],
    ['sin user', { c: CURSOR.createdAt }],
    ['sin fecha', { u: CURSOR.userId }],
    ['fecha inválida', { c: 'ayer', u: CURSOR.userId }],
    ['fecha imposible', { c: '2026-13-45T10:00:00Z', u: CURSOR.userId }],
    ['user que no es UUID', { c: CURSOR.createdAt, u: 'user-123' }],
    ['campos que no son texto', { c: 1, u: 2 }],
    ['intento de inyección en el filtro', { c: `${CURSOR.createdAt},id.gt.0`, u: CURSOR.userId }],
  ])('un token auténtico con contenido inválido también se rechaza (%s)', (_label, payload) => {
    expect(codec.decode(forge(payload))).toBeNull();
  });

  it('exige un secreto de al menos el largo mínimo', () => {
    expect(() => createReviewsCursorCodec('corto')).toThrow(/REVIEWS_CURSOR_SECRET/);
    expect(() =>
      createReviewsCursorCodec('x'.repeat(REVIEWS_CURSOR_SECRET_MIN_LENGTH - 1)),
    ).toThrow();
    expect(() =>
      createReviewsCursorCodec('x'.repeat(REVIEWS_CURSOR_SECRET_MIN_LENGTH)),
    ).not.toThrow();
  });
});
