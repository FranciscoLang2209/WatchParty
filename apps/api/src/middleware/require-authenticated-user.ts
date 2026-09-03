import type { NextFunction, Request, Response } from 'express';
import { supabaseAuthClient } from '../auth/supabase-auth-client.js';
import { UnauthorizedError } from '../errors/http-error.js';

const BEARER_PREFIX = 'Bearer ';

export async function requireAuthenticatedUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authorization = req.header('Authorization');

  if (!authorization?.startsWith(BEARER_PREFIX)) {
    next(new UnauthorizedError());
    return;
  }

  const accessToken = authorization.slice(BEARER_PREFIX.length).trim();

  if (!accessToken) {
    next(new UnauthorizedError());
    return;
  }

  const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);

  if (error || !data.user?.email) {
    next(new UnauthorizedError());
    return;
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}
