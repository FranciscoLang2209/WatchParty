import { Router } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createGetOwnReviewHandler } from './get-own-review-handler.js';

/**
 * Se monta bajo `/matches` en app.ts: `GET /matches/:matchId/review` (leer).
 * `review` va en singular: es la reseña PROPIA del usuario autenticado, no
 * una colección. Guardar o editar queda fuera de WAT-253.
 */
export function createMatchReviewsRouter(service: MatchReviewService): Router {
  const router = Router();

  router.get('/:matchId/review', requireAuthenticatedUser, createGetOwnReviewHandler(service));

  return router;
}
