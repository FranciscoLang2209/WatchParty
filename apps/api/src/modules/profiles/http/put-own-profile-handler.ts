import type { RequestHandler } from 'express';
import type { OwnProfileStore, SaveOwnProfileInput } from '../domain/own-profile-store.js';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  UUID_PATTERN,
} from '../domain/own-profile-store.js';
import { ProfileValidationError } from '../domain/profile-validation-error.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';

const ALLOWED_KEYS = ['displayName', 'bio', 'favoriteTeamId'];

/**
 * Valida forma, tipos y límites de formato ANTES de llamar al store — un
 * payload inválido nunca debe tocar la persistencia (WAT-130). La
 * existencia real de favoriteTeamId en `teams` queda fuera de acá a
 * propósito: solo el store puede confirmarla contra la base.
 */
function parseBody(body: unknown): SaveOwnProfileInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const keys = Object.keys(body);
  if (keys.length !== ALLOWED_KEYS.length || !ALLOWED_KEYS.every((key) => keys.includes(key))) {
    return null;
  }

  const { displayName, bio, favoriteTeamId } = body as Record<string, unknown>;

  if (typeof displayName !== 'string' || typeof bio !== 'string') return null;
  if (favoriteTeamId !== null && typeof favoriteTeamId !== 'string') return null;

  const trimmedDisplayName = displayName.trim();
  if (
    trimmedDisplayName.length < DISPLAY_NAME_MIN_LENGTH ||
    trimmedDisplayName.length > DISPLAY_NAME_MAX_LENGTH
  ) {
    return null;
  }

  if (bio.length > BIO_MAX_LENGTH) return null;
  if (favoriteTeamId !== null && !UUID_PATTERN.test(favoriteTeamId)) return null;

  return { displayName: trimmedDisplayName, bio, favoriteTeamId };
}

export function createPutOwnProfileHandler(store: OwnProfileStore): RequestHandler {
  return async (req, res, next) => {
    const input = parseBody(req.body);

    if (!input) {
      next(new ValidationError());
      return;
    }

    try {
      const profile = await store.saveOwnProfile(req.user!.id, input);
      res.status(200).json({ profile });
    } catch (error) {
      if (error instanceof ProfileValidationError && error.issue === 'favorite_team_not_found') {
        next(new NotFoundError(error.message));
        return;
      }
      throw error;
    }
  };
}
