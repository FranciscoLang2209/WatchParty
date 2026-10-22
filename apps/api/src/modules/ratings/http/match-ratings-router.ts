import { Router } from 'express';
import type { MatchRatingService } from '../application/match-rating-service.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createGetRatingSummaryHandler } from './get-rating-summary-handler.js';
import { createGetOwnRatingHandler } from './get-own-rating-handler.js';
import { createSaveOwnRatingHandler } from './save-own-rating-handler.js';

/**
 * Se monta bajo `/matches` en app.ts: `GET /matches/:matchId/rating` (leer) y
 * `PUT /matches/:matchId/rating` (guardar o editar). `rating` va en singular:
 * es la nota PROPIA del usuario autenticado, no una colección. No hay DELETE
 * (fuera del alcance de WAT-212). `GET /matches/:matchId/rating-summary`
 * (WAT-214) expone el promedio y la cantidad de votos del partido, sin notas
 * ajenas.
 */
export function createMatchRatingsRouter(service: MatchRatingService): Router {
  const router = Router();

  router.get('/:matchId/rating', requireAuthenticatedUser, createGetOwnRatingHandler(service));
  router.get(
    '/:matchId/rating-summary',
    requireAuthenticatedUser,
    createGetRatingSummaryHandler(service),
  );
  router.put('/:matchId/rating', requireAuthenticatedUser, createSaveOwnRatingHandler(service));

  return router;
}
