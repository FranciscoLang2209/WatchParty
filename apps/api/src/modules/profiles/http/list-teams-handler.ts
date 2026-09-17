import type { RequestHandler } from 'express';
import type { OwnProfileStore } from '../domain/own-profile-store.js';

export function createListTeamsHandler(store: OwnProfileStore): RequestHandler {
  return async (_req, res) => {
    const teams = await store.listTeams();
    res.status(200).json({ teams });
  };
}
