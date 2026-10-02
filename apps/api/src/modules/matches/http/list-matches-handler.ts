import type { RequestHandler } from 'express';
import type { Match } from '../domain/match.js';
import type { MatchCatalog } from '../domain/match-catalog.js';
import { agendaWindow } from '../domain/match-window.js';
import { toMatchResponse } from './match-response.js';

function compareMatches(a: Match, b: Match): number {
  const kickoffDiff = Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt);
  if (kickoffDiff !== 0) return kickoffDiff;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Lista sólo la agenda de la ventana móvil (WAT-189). `now` es el reloj: se
 * consulta en cada pedido, así la ventana avanza sola con el día UTC.
 */
export function createListMatchesHandler(
  catalog: MatchCatalog,
  now: () => Date = () => new Date(),
): RequestHandler {
  return async (_req, res) => {
    const matches = await catalog.list(agendaWindow(now()));
    const sorted = [...matches].sort(compareMatches);

    res.status(200).json({ matches: sorted.map(toMatchResponse) });
  };
}
