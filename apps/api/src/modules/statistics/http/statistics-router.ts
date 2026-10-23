import { Router } from 'express';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import type { UserStatisticsStore } from '../domain/user-statistics-store.js';
import { createGetOwnStatisticsHandler } from './get-own-statistics-handler.js';

/**
 * Se monta bajo el prefijo `/me` en app.ts: `GET /me/statistics` son los
 * totales PROPIOS del usuario autenticado, mismo criterio que
 * `/me/watched-matches`.
 */
export function createStatisticsRouter(store: UserStatisticsStore): Router {
  const router = Router();

  router.get('/statistics', requireAuthenticatedUser, createGetOwnStatisticsHandler(store));

  return router;
}
