import { Router } from 'express';
import type { PublicRoomStore } from '../domain/public-room-store.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createEnterRoomHandler } from './enter-room-handler.js';
import { createGetRoomHandler } from './get-room-handler.js';

export function createRoomsRouter(store: PublicRoomStore): Router {
  const router = Router();

  router.post('/matches/:matchId/room', requireAuthenticatedUser, createEnterRoomHandler(store));
  router.get('/rooms/:roomId', requireAuthenticatedUser, createGetRoomHandler(store));

  return router;
}
