import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProfilesRouter } from './profiles-router.js';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { OwnProfileStore } from '../domain/own-profile-store.js';
import type { Profile } from '../domain/profile.js';
import { ProfileValidationError } from '../domain/profile-validation-error.js';

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

  app.use(express.json());
  app.use(createProfilesRouter(store));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const VALID_BODY = {
  displayName: 'Tomi',
  bio: 'Hincha de River',
  favoriteTeamId: '11111111-1111-1111-1111-111111111111',
};

const SAVED_PROFILE: Profile = { ...VALID_BODY };

describe('PUT /me/profile', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('con body válido crea o actualiza el perfil y responde 200', async () => {
    mockAuthenticated();
    const saveOwnProfile = vi.fn(async () => SAVED_PROFILE);
    const app = buildTestApp(buildStore({ saveOwnProfile }));

    const response = await request(app)
      .put('/me/profile')
      .set('Authorization', 'Bearer good-token')
      .send(VALID_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profile: SAVED_PROFILE });
    expect(saveOwnProfile).toHaveBeenCalledWith('user-123', VALID_BODY);
  });

  it('favoriteTeamId null elimina el favorito', async () => {
    mockAuthenticated();
    const saveOwnProfile = vi.fn(async () => ({ ...SAVED_PROFILE, favoriteTeamId: null }));
    const app = buildTestApp(buildStore({ saveOwnProfile }));

    const response = await request(app)
      .put('/me/profile')
      .set('Authorization', 'Bearer good-token')
      .send({ ...VALID_BODY, favoriteTeamId: null });

    expect(response.status).toBe(200);
    expect(saveOwnProfile).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ favoriteTeamId: null }),
    );
  });

  it('sin token no invoca el store y responde 401 UNAUTHORIZED', async () => {
    const saveOwnProfile = vi.fn();
    const app = buildTestApp(buildStore({ saveOwnProfile }));

    const response = await request(app).put('/me/profile').send(VALID_BODY);

    expect(response.status).toBe(401);
    expect(saveOwnProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['falta un campo', { displayName: 'Tomi', bio: 'x' }],
    ['tiene un campo extra', { ...VALID_BODY, extra: 'no' }],
    ['displayName no es string', { ...VALID_BODY, displayName: 123 }],
    ['displayName vacío tras trim', { ...VALID_BODY, displayName: '   ' }],
    ['displayName supera 50 caracteres', { ...VALID_BODY, displayName: 'a'.repeat(51) }],
    ['bio supera 280 caracteres', { ...VALID_BODY, bio: 'a'.repeat(281) }],
    ['favoriteTeamId no es UUID ni null', { ...VALID_BODY, favoriteTeamId: 'no-es-un-uuid' }],
    ['favoriteTeamId no es string ni null', { ...VALID_BODY, favoriteTeamId: 123 }],
  ])(
    'un payload inválido (%s) no llama al store y responde 400 VALIDATION_ERROR',
    async (_case, body) => {
      mockAuthenticated();
      const saveOwnProfile = vi.fn();
      const app = buildTestApp(buildStore({ saveOwnProfile }));

      const response = await request(app)
        .put('/me/profile')
        .set('Authorization', 'Bearer good-token')
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
      expect(saveOwnProfile).not.toHaveBeenCalled();
    },
  );

  it('un equipo inexistente responde 404 NOT_FOUND', async () => {
    mockAuthenticated();
    const saveOwnProfile = vi.fn(async () => {
      throw new ProfileValidationError('favorite_team_not_found', 'El equipo no existe.');
    });
    const app = buildTestApp(buildStore({ saveOwnProfile }));

    const response = await request(app)
      .put('/me/profile')
      .set('Authorization', 'Bearer good-token')
      .send(VALID_BODY);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('un fallo no controlado del store responde 500 INTERNAL_ERROR sin detalles internos', async () => {
    mockAuthenticated();
    const app = buildTestApp(
      buildStore({
        saveOwnProfile: async () => {
          throw new Error('detalle interno de base de datos');
        },
      }),
    );

    const response = await request(app)
      .put('/me/profile')
      .set('Authorization', 'Bearer good-token')
      .send(VALID_BODY);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });

  it('un JSON malformado responde 400 VALIDATION_ERROR, no 500', async () => {
    mockAuthenticated();
    const saveOwnProfile = vi.fn();
    const app = buildTestApp(buildStore({ saveOwnProfile }));

    const response = await request(app)
      .put('/me/profile')
      .set('Authorization', 'Bearer good-token')
      .set('Content-Type', 'application/json')
      .send('{ esto no es JSON válido');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    });
    expect(saveOwnProfile).not.toHaveBeenCalled();
  });
});
