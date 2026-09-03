import { Router } from 'express';
import type { MatchCatalog } from '../domain/match-catalog.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createListMatchesHandler } from './list-matches-handler.js';

export function createMatchesRouter(catalog: MatchCatalog): Router {
  const router = Router();

  router.get('/', requireAuthenticatedUser, createListMatchesHandler(catalog));

  return router;
}
