import type { RequestHandler } from 'express';
import type { Match } from '../domain/match.js';
import type { MatchCatalog } from '../domain/match-catalog.js';
import { toMatchResponse } from './match-response.js';

function compareMatches(a: Match, b: Match): number {
  if (a.kickoffAt !== b.kickoffAt) return a.kickoffAt < b.kickoffAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function createListMatchesHandler(catalog: MatchCatalog): RequestHandler {
  return async (_req, res) => {
    const matches = await catalog.list();
    const sorted = [...matches].sort(compareMatches);

    res.status(200).json({ matches: sorted.map(toMatchResponse) });
  };
}
