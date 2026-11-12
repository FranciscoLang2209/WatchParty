import { Router } from 'express';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { MatchEnrichmentReader } from '../domain/match-enrichment.js';
import { createHistoricalDetailHandler } from './historical-detail-handler.js';

export function createMatchEnrichmentRouter(
  catalog: MatchCatalog,
  reader: MatchEnrichmentReader,
): Router {
  const router = Router();

  router.get(
    '/:matchId/historical-detail',
    requireAuthenticatedUser,
    createHistoricalDetailHandler(catalog, reader),
  );

  return router;
}
