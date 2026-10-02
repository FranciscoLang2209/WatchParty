import { Router } from 'express';
import type { WatchedMatchStore } from '../domain/watched-match-store.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createSetWatchedMatchHandler } from './set-watched-match-handler.js';

/**
 * Se monta bajo el prefijo `/matches` en app.ts, así que las rutas acá son
 * relativas: `PUT/DELETE /matches/:matchId/watched` (WAT-178).
 *
 * `watched` va en singular: es el estado de visto PROPIO del usuario
 * autenticado sobre ese partido, no una colección.
 */
export function createWatchedRouter(store: WatchedMatchStore): Router {
  const router = Router();

  router.put(
    '/:matchId/watched',
    requireAuthenticatedUser,
    createSetWatchedMatchHandler(store, true),
  );
  router.delete(
    '/:matchId/watched',
    requireAuthenticatedUser,
    createSetWatchedMatchHandler(store, false),
  );

  return router;
}
