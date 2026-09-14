import { describe, it, expect } from 'vitest';
import { SupabasePersistenceError } from './supabase-persistence-error.js';

/**
 * WAT-138: el build de Vercel fallaba con
 * `TS2554: Expected 0-1 arguments, but got 2` en el `super(message, { cause })`
 * de esta clase, porque allá el `lib` efectivo queda por debajo de ES2022 y
 * el overload de dos argumentos de `Error` no existe.
 *
 * La clase pasó a setear `cause` sin depender de ese overload. Estos tests
 * fijan lo que no puede cambiar en el camino: que `cause` se siga
 * preservando para los logs del `errorHandler`, y que la propiedad conserve
 * la misma semántica que la nativa (no enumerable, pero escribible y
 * configurable) para que nada que trate a este error como un `Error` común
 * se rompa.
 */
describe('SupabasePersistenceError', () => {
  it('expone el mensaje propio y el nombre de la clase', () => {
    const error = new SupabasePersistenceError('No se pudo listar los partidos.');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('No se pudo listar los partidos.');
    expect(error.name).toBe('SupabasePersistenceError');
  });

  it('preserva el error original en cause para diagnóstico en logs', () => {
    const original = { code: '23505', details: 'duplicate key' };

    const error = new SupabasePersistenceError('No se pudo guardar el partido.', original);

    expect(error.cause).toBe(original);
  });

  it('mantiene la misma semántica de propiedad que el cause nativo de Error', () => {
    const error = new SupabasePersistenceError('falló', new Error('raíz'));

    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    const nativeDescriptor = Object.getOwnPropertyDescriptor(
      new Error('falló', { cause: new Error('raíz') }),
      'cause',
    );

    expect(descriptor).toBeDefined();
    expect(descriptor!.enumerable).toBe(nativeDescriptor!.enumerable);
    expect(descriptor!.writable).toBe(nativeDescriptor!.writable);
    expect(descriptor!.configurable).toBe(nativeDescriptor!.configurable);
  });

  it('no define cause cuando no se pasa un error original', () => {
    const error = new SupabasePersistenceError('falló sin causa');

    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  });

  it('no filtra el cause en la serialización JSON de la respuesta', () => {
    const error = new SupabasePersistenceError('falló', { secreto: 'no-exponer' });

    expect(JSON.stringify(error)).not.toContain('no-exponer');
  });
});
