import { Router } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createDeleteOwnReviewHandler } from './delete-own-review-handler.js';
import { createListMatchReviewsHandler } from './list-match-reviews-handler.js';
import { createGetOwnReviewHandler } from './get-own-review-handler.js';
import { createSaveOwnReviewHandler } from './save-own-review-handler.js';

/**
 * Se monta bajo `/matches` en app.ts: `GET /matches/:matchId/review` (leer) y
 * `PUT /matches/:matchId/review` (guardar o editar) y
 * `DELETE /matches/:matchId/review` (eliminar el texto). `review` va en
 * singular: es la reseña PROPIA del usuario autenticado, no una colección.
 * `GET /matches/:matchId/reviews` (plural, WAT-256) lista las opiniones
 * públicas de un partido, paginadas por cursor.
 */
export function createMatchReviewsRouter(service: MatchReviewService): Router {
  const router = Router();

  router.get('/:matchId/review', requireAuthenticatedUser, createGetOwnReviewHandler(service));
  router.put('/:matchId/review', requireAuthenticatedUser, createSaveOwnReviewHandler(service));
  router.get('/:matchId/reviews', requireAuthenticatedUser, createListMatchReviewsHandler(service));
  router.delete(
    '/:matchId/review',
    requireAuthenticatedUser,
    createDeleteOwnReviewHandler(service),
  );

  return router;
}
