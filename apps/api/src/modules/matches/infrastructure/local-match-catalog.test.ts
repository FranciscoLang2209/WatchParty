import { describe, it, expect } from 'vitest';
import { LocalMatchCatalog } from './local-match-catalog.js';

describe('LocalMatchCatalog', () => {
  it('lista al menos tres partidos', async () => {
    const catalog = new LocalMatchCatalog();
    const matches = await catalog.list();
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('los IDs de los partidos son unicos y estables entre llamadas', async () => {
    const catalog = new LocalMatchCatalog();

    const first = await catalog.list();
    const second = await catalog.list();

    const ids = first.map((match) => match.id);

    expect(new Set(ids).size).toBe(ids.length); //que haya misma cantidad de ids
    expect(second.map((match) => match.id)).toEqual(ids); //que perduren con las llamadas
  });
  it('encuentra un partido existente por ID', async () => {
    const catalog = new LocalMatchCatalog();

    const matches = await catalog.list();
    const expected = matches[0];
    if (!expected) {
      throw new Error('El catálogo local debe tener al menos un partido para este test');
    }

    const found = await catalog.findById(expected.id);
    expect(found).toEqual(expected);
  });
  it('devuelve null para un ID inexistente', async () => {
    const catalog = new LocalMatchCatalog();

    const found = await catalog.findById('id-que-no-existe');

    expect(found).toBeNull();
  });
});
