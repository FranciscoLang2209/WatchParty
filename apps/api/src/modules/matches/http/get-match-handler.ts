import type { RequestHandler } from 'express';
import type { MatchCatalog } from '../domain/match-catalog.js';
import { NotFoundError } from '../../../errors/http-error.js';
import { toMatchResponse } from './match-response.js';

export function createMatchHandler(catalog: MatchCatalog): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;
    const match = await catalog.findById(matchId);

    if (!match) {
      next(new NotFoundError());
      return;
    }

    res.status(200).json({ match: toMatchResponse(match) });
  };
}
