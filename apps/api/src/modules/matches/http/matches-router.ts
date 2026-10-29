import { Router } from 'express';
import type { MatchCatalog } from '../domain/match-catalog.js';
import type { MatchSearch } from '../domain/match-search.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createListMatchesHandler } from './list-matches-handler.js';
import { createMatchHandler } from './get-match-handler.js';
import { createSearchMatchesHandler } from './search-matches-handler.js';

export function createMatchesRouter(
  catalog: MatchCatalog,
  now?: () => Date,
  search?: MatchSearch,
): Router {
  const router = Router();

  router.get('/', requireAuthenticatedUser, createListMatchesHandler(catalog, now));
  // Antes de `/:matchId`: si no, «search» se leería como el id de un partido.
  if (search) {
    router.get('/search', requireAuthenticatedUser, createSearchMatchesHandler(search));
  }

  router.get('/:matchId', requireAuthenticatedUser, createMatchHandler(catalog));

  return router;
}
