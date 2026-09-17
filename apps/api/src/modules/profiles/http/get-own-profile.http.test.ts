import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProfilesRouter } from './profiles-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { OwnProfileStore } from '../domain/own-profile-store.js';
import type { Profile } from '../domain/profile.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: { id: 'user-123', email: 'persona@example.com' } },
    error: null,
  } as GetUserResult);
}

function buildStore(overrides: Partial<OwnProfileStore> = {}): OwnProfileStore {
  return {
    getOwnProfile: async () => null,
    saveOwnProfile: async (_userId, input) => ({ ...input }),
    listTeams: async () => [],
    ...overrides,
  };
}

function buildTestApp(store: OwnProfileStore) {
  const app = express();

  app.use(createProfilesRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const PROFILE: Profile = {
  displayName: 'Tomi',
  bio: 'Hincha de River',
  favoriteTeamId: 'aaa-bbb',
};

describe('GET /me/profile', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido y perfil existente responde 200 con el perfil', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ getOwnProfile: async () => PROFILE }));

    const response = await request(app)
      .get('/me/profile')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profile: PROFILE });
  });

  it('con token válido y sin perfil todavía responde 200 con profile: null (no 404)', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ getOwnProfile: async () => null }));

    const response = await request(app)
      .get('/me/profile')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profile: null });
  });

  it('sin token no invoca el store y responde 401 UNAUTHORIZED', async () => {
    const getOwnProfile = vi.fn();
    const app = buildTestApp(buildStore({ getOwnProfile }));

    const response = await request(app).get('/me/profile');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(getOwnProfile).not.toHaveBeenCalled();
  });

  it('con un token inválido no invoca el store y responde 401 UNAUTHORIZED', async () => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    } as GetUserResult);

    const getOwnProfile = vi.fn();
    const app = buildTestApp(buildStore({ getOwnProfile }));

    const response = await request(app).get('/me/profile').set('Authorization', 'Bearer bad-token');

    expect(response.status).toBe(401);
    expect(getOwnProfile).not.toHaveBeenCalled();
  });

  it('un fallo no controlado del store responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      buildStore({
        getOwnProfile: async () => {
          throw new Error('detalle interno de base de datos');
        },
      }),
    );

    const response = await request(app)
      .get('/me/profile')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });
});
