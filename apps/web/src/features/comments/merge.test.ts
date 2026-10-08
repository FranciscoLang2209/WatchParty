import { describe, expect, it } from 'vitest';
import { mergeComments } from './merge';
import type { RoomComment } from './types';

function comentario(id: string, createdAt: string): RoomComment {
  return { id, roomId: 'room-1', body: `Comentario ${id}`, createdAt };
}

const A = comentario('a', '2026-09-24T21:00:00.000Z');
const B = comentario('b', '2026-09-24T21:01:00.000Z');
const C = comentario('c', '2026-09-24T21:02:00.000Z');

describe('mergeComments', () => {
  it('deja una sola vez un comentario presente en ambas listas', () => {
    expect(mergeComments([A, B], [B, C])).toEqual([A, B, C]);
  });

  it('agrega el que faltaba en memoria en su lugar cronológico', () => {
    expect(mergeComments([A, C], [A, B, C])).toEqual([A, B, C]);
  });

  it('conserva el que está en memoria y todavía no vino en la respuesta', () => {
    expect(mergeComments([A, C], [A, B])).toEqual([A, B, C]);
  });

  it('ante el mismo milisegundo deja lo nuevo después de lo que ya estaba, sin desempatar por id', () => {
    // El servidor ordena por microsegundos: «z» fue antes que «m» aunque su id
    // sea mayor, y la API publica a ambos con el mismo milisegundo.
    const primero = comentario('z', '2026-09-24T21:00:00.123Z');
    const segundo = comentario('m', '2026-09-24T21:00:00.123Z');

    expect(mergeComments([A, primero], [segundo])).toEqual([A, primero, segundo]);
  });

  it('entre los nuevos del mismo milisegundo conserva el orden recibido', () => {
    const primero = comentario('z', '2026-09-24T21:00:00.123Z');
    const segundo = comentario('m', '2026-09-24T21:00:00.123Z');

    expect(mergeComments([A], [primero, segundo])).toEqual([A, primero, segundo]);
  });

  it('no reordena lo que ya estaba al recibirlo de nuevo', () => {
    const primero = comentario('z', '2026-09-24T21:00:00.123Z');
    const segundo = comentario('m', '2026-09-24T21:00:00.123Z');

    expect(mergeComments([primero, segundo], [segundo, primero])).toEqual([primero, segundo]);
  });

  it('ordena por instante aunque las fechas vengan con distinto formato', () => {
    const conOffset = comentario('x', '2026-09-24T21:00:30+00:00');

    expect(mergeComments([B], [A, conOffset])).toEqual([A, conOffset, B]);
  });

  it('no modifica las listas que recibe', () => {
    const actuales = [C, A];
    const recibidos = [B];

    mergeComments(actuales, recibidos);

    expect(actuales).toEqual([C, A]);
    expect(recibidos).toEqual([B]);
  });
});
