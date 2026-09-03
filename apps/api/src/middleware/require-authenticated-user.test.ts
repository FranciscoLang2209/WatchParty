import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAuthenticatedUser } from './require-authenticated-user.js';
import { supabaseAuthClient } from '../auth/supabase-auth-client.js';

vi.mock('../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function buildTestApp() {
  const app = express();

  app.get('/protected', requireAuthenticatedUser, (req, res) => {
    res.status(200).json({ user: req.user });
  });

  return app;
}

describe('requireAuthenticatedUser', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('responde 401 sin header Authorization', async () => {
    const response = await request(buildTestApp()).get('/protected');

    expect(response.status).toBe(401);
  });

  it('responde 401 con un esquema distinto de Bearer', async () => {
    const response = await request(buildTestApp())
      .get('/protected')
      .set('Authorization', 'Basic abc123');

    expect(response.status).toBe(401);
  });

  it('responde 401 con un token rechazado por Supabase', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);

    const response = await request(buildTestApp())
      .get('/protected')
      .set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
  });

  it('con un token válido, expone sólo id y email verificados', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: { id: 'user-123', email: 'persona@example.com' } },
      error: null,
    } as GetUserResult);

    const response = await request(buildTestApp())
      .get('/protected')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: { id: 'user-123', email: 'persona@example.com' } });
  });
});
