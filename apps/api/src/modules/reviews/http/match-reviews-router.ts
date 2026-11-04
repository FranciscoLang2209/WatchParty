import { Router } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createGetOwnReviewHandler } from './get-own-review-handler.js';
import { createSaveOwnReviewHandler } from './save-own-review-handler.js';

/**
 * Se monta bajo `/matches` en app.ts: `GET /matches/:matchId/review` (leer) y
 * `PUT /matches/:matchId/review` (guardar o editar). `review` va en singular:
 * es la reseña PROPIA del usuario autenticado, no una colección. No hay
 * DELETE (fuera del alcance de WAT-254).
 */
export function createMatchReviewsRouter(service: MatchReviewService): Router {
  const router = Router();

  router.get('/:matchId/review', requireAuthenticatedUser, createGetOwnReviewHandler(service));
  router.put('/:matchId/review', requireAuthenticatedUser, createSaveOwnReviewHandler(service));

  return router;
}
