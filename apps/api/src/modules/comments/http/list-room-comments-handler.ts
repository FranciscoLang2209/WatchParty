import type { RequestHandler } from 'express';
import type { RoomCommentStore } from '../domain/room-comment-store.js';
import { NotFoundError } from '../../../errors/http-error.js';
import { toRoomCommentResponse } from './room-comment-response.js';

export function createListRoomCommentsHandler(
  store: RoomCommentStore,
): RequestHandler<{ roomId: string }> {
  return async (req, res, next) => {
    const { roomId } = req.params;
    const comments = await store.listByRoom(roomId);

    if (!comments) {
      next(new NotFoundError());
      return;
    }

    res.status(200).json({ comments: comments.map(toRoomCommentResponse) });
  };
}
