import type { Match } from '../domain/match.js';
import type { MatchCatalog } from '../domain/match-catalog.js';

/**
 * Catálogo de partidos embebido en memoria.
 *
 * Implementación TEMPORAL de `MatchCatalog` mientras no exista un proveedor
 * deportivo real. Los IDs son estables a propósito: WAT-95 y WAT-96
 * dependen de este catálogo y no deben romperse cuando se lo reemplace por
 * un adaptador de proveedor, siempre que ese adaptador respete el mismo
 * puerto `MatchCatalog`.
 */

const MATCHES: readonly Match[] = [
  {
    id: 'match-001',
    homeTeam: 'River Plate',
    awayTeam: 'Boca Juniors',
    kickoffAt: '2026-09-06T21:00:00Z',
    status: 'scheduled',
  },
  {
    id: 'match-002',
    homeTeam: 'Real Madrid',
    awayTeam: 'FC Barcelona',
    kickoffAt: '2026-09-13T19:00:00Z',
    status: 'scheduled',
  },
  {
    id: 'match-003',
    homeTeam: 'Manchester City',
    awayTeam: 'Liverpool',
    kickoffAt: '2026-08-30T14:30:00Z',
    status: 'finished',
  },
];

export class LocalMatchCatalog implements MatchCatalog {
  async list(): Promise<readonly Match[]> {
    // es el patron await async, esta funcion devuelve una 'promesa' que va a devolver una lista de matches. Aca nunca falla.
    return MATCHES;
  }

  async findById(id: string): Promise<Match | null> {
    const match = MATCHES.find((candidate) => candidate.id === id);
    return match ?? null;
  }
}
