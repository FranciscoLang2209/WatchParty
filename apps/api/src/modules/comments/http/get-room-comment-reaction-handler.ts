import type { RequestHandler } from 'express';
import type { RoomCommentReactionStore } from '../domain/room-comment-reaction-store.js';
import { UUID_PATTERN } from '../domain/room-comment-store.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { toRoomCommentReactionResponse } from './room-comment-reaction-response.js';

/** GET de la reacción de un comentario (WAT-206). Mismas reglas que el handler PUT/DELETE (WAT-176). */
export function createGetRoomCommentReactionHandler(
  store: RoomCommentReactionStore,
): RequestHandler<{ roomId: string; commentId: string }> {
  return async (req, res, next) => {
    const { roomId, commentId } = req.params;

    if (!UUID_PATTERN.test(roomId) || !UUID_PATTERN.test(commentId)) {
      next(new ValidationError());
      return;
    }

    const state = await store.getReaction({ roomId, commentId, userId: req.user!.id });

    if (!state) {
      next(new NotFoundError());
      return;
    }

    res.status(200).json({ reaction: toRoomCommentReactionResponse(state) });
  };
}
