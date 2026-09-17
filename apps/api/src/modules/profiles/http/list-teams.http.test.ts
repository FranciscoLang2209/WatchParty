import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProfilesRouter } from './profiles-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { OwnProfileStore } from '../domain/own-profile-store.js';
import type { TeamOption } from '../domain/team-option.js';

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

const TEAM_A: TeamOption = { id: 'aaa', name: 'Boca Juniors' };
const TEAM_B: TeamOption = { id: 'bbb', name: 'River Plate' };

describe('GET /teams', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con token válido responde 200 con los equipos del store', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ listTeams: async () => [TEAM_A, TEAM_B] }));

    const response = await request(app).get('/teams').set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ teams: [TEAM_A, TEAM_B] });
  });

  it('con una lista vacía responde exactamente 200 { teams: [] }', async () => {
    mockAuthenticated();
    const app = buildTestApp(buildStore({ listTeams: async () => [] }));

    const response = await request(app).get('/teams').set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ teams: [] });
  });

  it('sin token no invoca el store y responde 401 UNAUTHORIZED', async () => {
    const listTeams = vi.fn();
    const app = buildTestApp(buildStore({ listTeams }));

    const response = await request(app).get('/teams');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(listTeams).not.toHaveBeenCalled();
  });

  it('un fallo no controlado del store responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      buildStore({
        listTeams: async () => {
          throw new Error('detalle interno de base de datos');
        },
      }),
    );

    const response = await request(app).get('/teams').set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });
});
