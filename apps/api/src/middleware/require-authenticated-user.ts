import type { NextFunction, Request, Response } from 'express';
import { supabaseAuthClient } from '../auth/supabase-auth-client.js';

const BEARER_PREFIX = 'Bearer ';

export async function requireAuthenticatedUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authorization = req.header('Authorization');

  if (!authorization?.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: 'No autenticado.' });
    return;
  }

  const accessToken = authorization.slice(BEARER_PREFIX.length).trim();

  if (!accessToken) {
    res.status(401).json({ error: 'No autenticado.' });
    return;
  }

  const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);

  if (error || !data.user?.email) {
    res.status(401).json({ error: 'No autenticado.' });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}
