import { Router } from 'express';
import type { OwnProfileStore } from '../domain/own-profile-store.js';
import { requireAuthenticatedUser } from '../../../middleware/require-authenticated-user.js';
import { createGetOwnProfileHandler } from './get-own-profile-handler.js';
import { createListTeamsHandler } from './list-teams-handler.js';

export function createProfilesRouter(store: OwnProfileStore): Router {
  const router = Router();

  router.get('/me/profile', requireAuthenticatedUser, createGetOwnProfileHandler(store));
  router.get('/teams', requireAuthenticatedUser, createListTeamsHandler(store));

  return router;
}
