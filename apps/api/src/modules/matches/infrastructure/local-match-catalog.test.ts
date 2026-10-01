import { describe, it, expect } from 'vitest';
import { LocalMatchCatalog } from './local-match-catalog.js';

// Ventana amplia que cubre todo el catálogo embebido.
const TODO = { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' };

describe('LocalMatchCatalog', () => {
  it('lista al menos tres partidos', async () => {
    const catalog = new LocalMatchCatalog();
    const matches = await catalog.list(TODO);
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('los IDs de los partidos son unicos y estables entre llamadas', async () => {
    const catalog = new LocalMatchCatalog();

    const first = await catalog.list(TODO);
    const second = await catalog.list(TODO);

    const ids = first.map((match) => match.id);

    expect(new Set(ids).size).toBe(ids.length); //que haya misma cantidad de ids
    expect(second.map((match) => match.id)).toEqual(ids); //que perduren con las llamadas
  });
  it('encuentra un partido existente por ID', async () => {
    const catalog = new LocalMatchCatalog();

    const matches = await catalog.list(TODO);
    const expected = matches[0];
    if (!expected) {
      throw new Error('El catálogo local debe tener al menos un partido para este test');
    }

    const found = await catalog.findById(expected.id);
    expect(found).toEqual(expected);
  });
  it('lista sólo los partidos de la ventana: inicio inclusivo y fin exclusivo', async () => {
    const catalog = new LocalMatchCatalog();

    // match-001 arranca justo en `from` y match-002 justo en `to`.
    const matches = await catalog.list({
      from: '2026-09-06T21:00:00.000Z',
      to: '2026-09-13T19:00:00.000Z',
    });

    expect(matches.map((match) => match.id)).toEqual(['match-001']);
  });

  it('una ventana sin partidos devuelve una lista vacía', async () => {
    const catalog = new LocalMatchCatalog();

    const matches = await catalog.list({
      from: '2030-01-01T00:00:00.000Z',
      to: '2030-01-10T00:00:00.000Z',
    });

    expect(matches).toEqual([]);
  });

  it('findById encuentra un partido aunque quede fuera de cualquier ventana vigente', async () => {
    const catalog = new LocalMatchCatalog();

    expect((await catalog.findById('match-003'))?.id).toBe('match-003');
  });

  it('devuelve null para un ID inexistente', async () => {
    const catalog = new LocalMatchCatalog();

    const found = await catalog.findById('id-que-no-existe');

    expect(found).toBeNull();
  });
});
