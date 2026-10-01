import type { RoomComment } from './types';

/** Mismo orden que el servidor: por instante de creación y, ante empate, por `id`. */
function byCreation(a: RoomComment, b: RoomComment): number {
  const diferencia = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (diferencia !== 0) return diferencia;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fusiona la lista en memoria con una respuesta del servidor. La identidad es
 * el `id`: lo repetido queda una sola vez (gana la versión recibida) y lo que
 * sólo está en una de las dos se conserva. Devuelve una lista nueva en orden
 * cronológico, sin modificar las recibidas.
 */
export function mergeComments(
  current: readonly RoomComment[],
  incoming: readonly RoomComment[],
): RoomComment[] {
  const porId = new Map<string, RoomComment>();

  for (const comment of current) porId.set(comment.id, comment);
  for (const comment of incoming) porId.set(comment.id, comment);

  return [...porId.values()].sort(byCreation);
}
