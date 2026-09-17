import type { RequestHandler } from 'express';
import type { OwnProfileStore } from '../domain/own-profile-store.js';

export function createGetOwnProfileHandler(store: OwnProfileStore): RequestHandler {
  return async (req, res) => {
    const profile = await store.getOwnProfile(req.user!.id);
    res.status(200).json({ profile });
  };
}
