import type { Match } from '../domain/match.js';
import type { MatchCatalog } from '../domain/match-catalog.js';
import type { MatchStore } from '../domain/match-store.js';

/**
 * Adaptador de `MatchCatalog` respaldado por Supabase (WAT-106).
 *
 * Delega toda la persistencia en `MatchStore` y expone únicamente el
 * contrato público `Match`: los handlers HTTP (`list-matches-handler`,
 * `get-match-handler`) siguen sin conocer que existe Supabase detrás,
 * exactamente como con `LocalMatchCatalog`. Esta separación (catálogo
 * angosto para HTTP vs. store amplio para persistencia/importación) es la
 * que le permite a WAT-107 usar `MatchStore` directamente para importar
 * fixtures sin tocar este catálogo ni el contrato HTTP.
 *
 * No atrapa errores: cualquier falla de `MatchStore` (y por lo tanto de
 * Supabase) se propaga tal cual para que el middleware de errores la
 * traduzca a un 500. Nunca se sustituye por `[]`, `null` ni `LocalMatchCatalog`.
 */
export class SupabaseMatchCatalog implements MatchCatalog {
  constructor(private readonly store: MatchStore) {}

  async list(): Promise<readonly Match[]> {
    return this.store.list();
  }

  async findById(id: string): Promise<Match | null> {
    return this.store.findById(id);
  }
}
