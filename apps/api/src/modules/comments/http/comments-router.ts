import { Router } from 'express';
import type { RoomCommentStore } from '../domain/room-comment-store.js';
import type { RoomCommentReactionStore } from '../domain/room-comment-reaction-store.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createListRoomCommentsHandler } from './list-room-comments-handler.js';
import { createCreateRoomCommentHandler } from './create-room-comment-handler.js';
import { createSetRoomCommentReactionHandler } from './set-room-comment-reaction-handler.js';

/**
 * Se monta bajo el prefijo `/rooms` en app.ts (mismo criterio que
 * matches-router.ts bajo `/matches`), así que las rutas acá son relativas:
 * `GET/POST /rooms/:roomId/comments` y
 * `PUT/DELETE /rooms/:roomId/comments/:commentId/reaction` (WAT-176).
 *
 * `reaction` va en singular: es la reacción PROPIA del usuario autenticado
 * (una por comentario), no una colección.
 */
export function createCommentsRouter(
  store: RoomCommentStore,
  reactionStore: RoomCommentReactionStore,
): Router {
  const router = Router();

  router.get('/:roomId/comments', requireAuthenticatedUser, createListRoomCommentsHandler(store));
  router.post('/:roomId/comments', requireAuthenticatedUser, createCreateRoomCommentHandler(store));

  router.put(
    '/:roomId/comments/:commentId/reaction',
    requireAuthenticatedUser,
    createSetRoomCommentReactionHandler(reactionStore, true),
  );
  router.delete(
    '/:roomId/comments/:commentId/reaction',
    requireAuthenticatedUser,
    createSetRoomCommentReactionHandler(reactionStore, false),
  );

  return router;
}
