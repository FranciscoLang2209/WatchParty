import type { RoomComment } from './types';

/**
 * Instante de creación en milisegundos. El servidor ordena por `created_at`
 * con microsegundos pero lo publica truncado a milisegundos: dos comentarios
 * del mismo milisegundo no se pueden ordenar acá, sólo respetar el orden en
 * que llegaron.
 */
function instante(comment: RoomComment): number {
  return Date.parse(comment.createdAt);
}

/**
 * Fusiona la lista en memoria con una respuesta del servidor. La identidad es
 * el `id`: lo repetido queda una sola vez (gana la versión recibida, en el
 * lugar que ya ocupaba) y lo que sólo está en una de las dos se conserva.
 *
 * `current` ya está en el orden del servidor y no se reordena. Lo nuevo se
 * intercala por instante; ante el mismo milisegundo queda después de lo que ya
 * estaba y, entre sí, en el orden recibido. Así una página siguiente —que el
 * servidor garantiza posterior al cursor— nunca se mete delante de la
 * anterior. Devuelve una lista nueva, sin modificar las recibidas.
 */
export function mergeComments(
  current: readonly RoomComment[],
  incoming: readonly RoomComment[],
): RoomComment[] {
  const recibidos = new Map<string, RoomComment>();
  for (const comment of incoming) recibidos.set(comment.id, comment);

  const enMemoria = new Set(current.map((comment) => comment.id));
  const actuales = current.map((comment) => recibidos.get(comment.id) ?? comment);
  // `sort` es estable: los del mismo milisegundo conservan el orden recibido.
  const nuevos = [...recibidos.values()]
    .filter((comment) => !enMemoria.has(comment.id))
    .sort((a, b) => instante(a) - instante(b));

  const fusion: RoomComment[] = [];
  let i = 0;
  let j = 0;

  while (i < actuales.length && j < nuevos.length) {
    if (instante(nuevos[j]!) < instante(actuales[i]!)) fusion.push(nuevos[j++]!);
    else fusion.push(actuales[i++]!);
  }

  return fusion.concat(actuales.slice(i), nuevos.slice(j));
}
