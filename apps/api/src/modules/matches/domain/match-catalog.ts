import { Match } from './match.js';

/**
 * Puerto que expone el catálogo de partidos al resto del sistema.
 *
 * Cualquier implementación (catálogo local, adaptador de proveedor externo,
 * etc.) debe cumplir este contrato para que los consumidores HTTP no
 * necesiten cambiar cuando se reemplace la fuente de datos.
 */

export interface MatchCatalog {
  list(): Promise<readonly Match[]>;
  findById(id: string): Promise<Match | null>;
}
