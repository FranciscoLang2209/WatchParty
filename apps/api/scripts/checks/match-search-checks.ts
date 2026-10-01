import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckResult } from '../utils/db-checks.js';
import { SupabaseMatchSearch } from '../../src/modules/matches/infrastructure/supabase-match-search.js';

const TRICKY_TEAM_NAME = 'Club Social, Deportivo "La Unión" (Reserva)';

/**
 * Verifica contra PostgREST real (no un doble) que un nombre de equipo con
 * caracteres reservados por su sintaxis de filtro (coma, paréntesis,
 * comillas) no rompe la búsqueda ni el cursor de la página siguiente.
 * Un doble de test solo registra qué string se arma; no puede probar que
 * PostgREST la interpreta como se espera.
 */
export async function checkMatchSearchReservedCharacters(
  adminClient: SupabaseClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const search = new SupabaseMatchSearch(adminClient);

  const existing = await adminClient
    .from('teams')
    .select('id')
    .eq('provider', 'match-search-check')
    .eq('external_id', 'tricky-team')
    .maybeSingle();

  if (!existing.data) {
    const inserted = await adminClient
      .from('teams')
      .insert({
        provider: 'match-search-check',
        external_id: 'tricky-team',
        name: TRICKY_TEAM_NAME,
      })
      .select('id')
      .single();

    if (inserted.error || !inserted.data) {
      throw new Error(
        `No se pudo sembrar el equipo de prueba: ${inserted.error?.message ?? 'sin datos'}`,
      );
    }
  }

  try {
    const first = await search.search({ query: 'La Unión', kind: 'teams', limit: 1 });

    if (first.kind !== 'teams') {
      throw new Error('search() devolvió un kind inesperado para una búsqueda de teams.');
    }

    results.push({
      label:
        'Un nombre de equipo con coma, paréntesis y comillas se encuentra sin romper el filtro',
      passed: first.items.some((team) => team.name === TRICKY_TEAM_NAME),
      detail: `Encontrados: ${first.items.map((team) => team.name).join(', ') || 'ninguno'}`,
    });

    if (first.nextCursor) {
      const second = await search.search({
        query: 'La Unión',
        kind: 'teams',
        limit: 1,
        cursor: first.nextCursor,
      });

      if (second.kind !== 'teams') {
        throw new Error('search() devolvió un kind inesperado para una búsqueda de teams.');
      }

      results.push({
        label: 'El cursor armado con ese nombre se reutiliza sin romper el filtro',
        passed: true,
        detail: `Segunda página devolvió ${second.items.length} resultado(s) sin error.`,
      });
    }
  } catch (error) {
    results.push({
      label: 'La búsqueda con caracteres reservados no lanza un error de PostgREST',
      passed: false,
      detail: `Error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return results;
}
