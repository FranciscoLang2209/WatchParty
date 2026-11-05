import { describe, it, expect } from 'vitest';
import { decodeReviewsCursor, encodeReviewsCursor } from './match-review-cursor.js';

const CURSOR = {
  createdAt: '2026-11-01T10:00:00.123456+00:00',
  userId: 'b2222222-2222-4222-8222-222222222222',
};

const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursor de reseñas', () => {
  it('codifica y decodifica sin perder datos, incluidos los microsegundos', () => {
    expect(decodeReviewsCursor(encodeReviewsCursor(CURSOR))).toEqual(CURSOR);
  });

  it('es un único texto opaco, apto para query string, que no deja ver el user_id', () => {
    const encoded = encodeReviewsCursor(CURSOR);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain(CURSOR.userId);
  });

  it.each([
    ['vacío', ''],
    ['no es base64url', '%%%'],
    ['no es JSON', Buffer.from('hola').toString('base64url')],
    ['JSON que no es objeto', token('hola')],
    ['null', token(null)],
    ['sin user', token({ c: CURSOR.createdAt })],
    ['sin fecha', token({ u: CURSOR.userId })],
    ['fecha inválida', token({ c: 'ayer', u: CURSOR.userId })],
    ['fecha imposible', token({ c: '2026-13-45T10:00:00Z', u: CURSOR.userId })],
    ['user que no es UUID', token({ c: CURSOR.createdAt, u: 'user-123' })],
    ['campos que no son texto', token({ c: 1, u: 2 })],
    ['demasiado largo', 'a'.repeat(201)],
    [
      'intento de inyección en el filtro',
      token({ c: `${CURSOR.createdAt},id.gt.0`, u: CURSOR.userId }),
    ],
  ])('rechaza un cursor inválido (%s)', (_label, value) => {
    expect(decodeReviewsCursor(value)).toBeNull();
  });
});
