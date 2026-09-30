import type { Match } from './match.js';

/** Los dos universos de búsqueda que soporta este ticket. No hay un tercero. */
export type SearchKind = 'matches' | 'teams';

/**
 * Límites seguros de esta búsqueda, acordados por el módulo — un límite
 * fuera de rango se ajusta en la frontera del adapter en vez de fallar.
 */
export const SEARCH_MIN_LIMIT = 1;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_DEFAULT_LIMIT = 10;

/**
 * Pedido de búsqueda. `query` vacío o solo espacios no filtra por texto:
 * devuelve la primera página del universo elegido por `kind`.
 */
export interface SearchQuery {
  query: string;
  kind: SearchKind;
  limit: number;
  /** Cursor de una página anterior. `undefined`/`null` pide la primera página. */
  cursor?: string | null;
}

/** Proyección mínima de un equipo para el resultado de búsqueda. */
export interface TeamSearchResult {
  id: string;
  name: string;
}

export interface MatchSearchPage {
  kind: 'matches';
  items: readonly Match[];
  /** `null` cuando no hay otra página. */
  nextCursor: string | null;
}

export interface TeamSearchPage {
  kind: 'teams';
  items: readonly TeamSearchResult[];
  nextCursor: string | null;
}

export type SearchPage = MatchSearchPage | TeamSearchPage;

/**
 * Puerto de búsqueda acotada de partidos y equipos (WAT-167).
 *
 * Separado de `MatchCatalog`/`MatchStore` (mismo criterio de segregación de
 * interfaces que ya usa el módulo): ningún handler HTTP existe todavía para
 * esto, así que nada que ya dependa de `MatchCatalog` necesita conocerlo.
 */
export interface MatchSearch {
  search(query: SearchQuery): Promise<SearchPage>;
}
