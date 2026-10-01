import { Router } from 'express';
import type { RoomCommentStore } from '../domain/room-comment-store.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createListRoomCommentsHandler } from './list-room-comments-handler.js';
import { createCreateRoomCommentHandler } from './create-room-comment-handler.js';

/**
 * Se monta bajo el prefijo `/rooms` en app.ts (mismo criterio que
 * matches-router.ts bajo `/matches`), así que las rutas acá son relativas:
 * `GET/POST /rooms/:roomId/comments`.
 */
export function createCommentsRouter(store: RoomCommentStore): Router {
  const router = Router();

  router.get('/:roomId/comments', requireAuthenticatedUser, createListRoomCommentsHandler(store));
  router.post('/:roomId/comments', requireAuthenticatedUser, createCreateRoomCommentHandler(store));

  return router;
}
