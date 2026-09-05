import { Router } from 'express';
import type { MatchCatalog } from '../domain/match-catalog.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createListMatchesHandler } from './list-matches-handler.js';
import { createMatchHandler } from './get-match-handler.js';

export function createMatchesRouter(catalog: MatchCatalog): Router {
  const router = Router();

  router.get('/', requireAuthenticatedUser, createListMatchesHandler(catalog));
  router.get('/:matchId', requireAuthenticatedUser, createMatchHandler(catalog));

  return router;
}
