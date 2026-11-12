import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler, notFoundHandler } from '../../../middleware/error-handler.js';
import { supabaseAuthClient } from '../../../auth/supabase-auth-client.js';
import type { Match } from '../../matches/domain/match.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { HistoricalDetail, MatchEnrichmentReader } from '../domain/match-enrichment.js';
import { createMatchEnrichmentRouter } from './match-enrichment-router.js';

vi.mock('../../../auth/supabase-auth-client.js', () => ({
  supabaseAuthClient: { auth: { getUser: vi.fn() } },
}));

type GetUserResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

function mockAuthenticated(): void {
  vi.mocked(supabaseAuthClient.auth.getUser).mockResolvedValueOnce({
    data: { user: { id: 'user-123', email: 'persona@example.com' } },
    error: null,
  } as GetUserResult);
}

const MATCH: Match = {
  id: 'aaa',
  homeTeam: 'Spain',
  homeTeamId: 't-es',
  awayTeam: 'England',
  awayTeamId: 't-en',
  kickoffAt: '2024-07-14T19:00:00.000Z',
  status: 'finished',
  score: { home: 2, away: 1 },
};

const DETAIL: HistoricalDetail = {
  source: 'api-football',
  historical: true,
  statistics: {
    coverage: 'partial',
    fetchedAt: '2026-11-12T15:00:00.000Z',
    home: { possessionPct: 58, totalShots: 15, shotsOnGoal: 0, cornerKicks: null, fouls: 11 },
    away: { possessionPct: 42, totalShots: 9, shotsOnGoal: 3, cornerKicks: 0, fouls: null },
  },
  goals: {
    coverage: 'complete',
    fetchedAt: '2026-11-12T15:00:01.000Z',
    events: [
      { kind: 'goal', side: 'home', playerName: 'N. Williams', minute: 45, extraMinute: 2 },
      { kind: 'goal_cancelled', side: 'away', playerName: null, minute: 60, extraMinute: null },
      { kind: 'penalty_goal', side: 'away', playerName: 'H. Kane', minute: 90, extraMinute: 4 },
      {
        kind: 'shootout_goal',
        side: 'home',
        playerName: 'A. Morata',
        minute: 120,
        extraMinute: null,
      },
    ],
  },
};

function buildApp(reader: MatchEnrichmentReader, matches: readonly Match[] = [MATCH]) {
  const catalog: MatchCatalog = {
    list: async () => matches,
    findById: async (id) => matches.find((match) => match.id === id) ?? null,
  };
  const app = express();

  app.use('/matches', createMatchEnrichmentRouter(catalog, reader));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

describe('GET /matches/:matchId/historical-detail', () => {
  beforeEach(() => {
    vi.mocked(supabaseAuthClient.auth.getUser).mockReset();
  });

  it('exige sesión', async () => {
    const reader = { findHistoricalDetail: vi.fn() };

    const response = await request(buildApp(reader)).get('/matches/aaa/historical-detail');

    expect(response.status).toBe(401);
    expect(reader.findHistoricalDetail).not.toHaveBeenCalled();
  });

  it('responde 200 con estadísticas por lado y goles separados en juego, anulaciones y tanda', async () => {
    mockAuthenticated();
    const reader = { findHistoricalDetail: vi.fn(async () => DETAIL) };

    const response = await request(buildApp(reader))
      .get('/matches/aaa/historical-detail')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body.detail).toMatchObject({
      source: 'api-football',
      historical: true,
      statistics: {
        coverage: 'partial',
        fetchedAt: '2026-11-12T15:00:00.000Z',
        // null (sin dato) y 0 (cero real) llegan distintos.
        home: { shotsOnGoal: 0, cornerKicks: null },
        away: { cornerKicks: 0, fouls: null },
      },
      goals: {
        coverage: 'complete',
        goals: [
          { kind: 'goal', side: 'home', playerName: 'N. Williams', minute: 45, extraMinute: 2 },
          { kind: 'penalty_goal', side: 'away', playerName: 'H. Kane', minute: 90, extraMinute: 4 },
        ],
        cancelled: [{ kind: 'goal_cancelled', side: 'away', playerName: null, minute: 60 }],
        shootout: [{ kind: 'shootout_goal', side: 'home', playerName: 'A. Morata', minute: 120 }],
      },
    });
    expect(reader.findHistoricalDetail).toHaveBeenCalledWith('aaa');
  });

  it('un partido existente sin enriquecer responde 200 con detail: null (no es un error)', async () => {
    mockAuthenticated();

    const response = await request(buildApp({ findHistoricalDetail: async () => null }))
      .get('/matches/aaa/historical-detail')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ detail: null });
  });

  it('con sólo una parte cargada, la otra llega null', async () => {
    mockAuthenticated();

    const response = await request(
      buildApp({ findHistoricalDetail: async () => ({ ...DETAIL, goals: null }) }),
    )
      .get('/matches/aaa/historical-detail')
      .set('Authorization', 'Bearer token');

    expect(response.body.detail.goals).toBeNull();
    expect(response.body.detail.statistics).not.toBeNull();
  });

  it('un partido inexistente es 404 y no consulta el enriquecimiento', async () => {
    mockAuthenticated();
    const reader = { findHistoricalDetail: vi.fn() };

    const response = await request(buildApp(reader))
      .get('/matches/no-existe/historical-detail')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(404);
    expect(reader.findHistoricalDetail).not.toHaveBeenCalled();
  });

  it('un fallo de lectura es 500 genérico: no se sustituye por «sin datos» ni filtra detalles', async () => {
    mockAuthenticated();
    const reader = {
      findHistoricalDetail: vi.fn(async () => {
        throw new Error('detalle interno');
      }),
    };

    const response = await request(buildApp(reader))
      .get('/matches/aaa/historical-detail')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('detalle interno');
  });

  it('no deja la ruta del detalle ni la del listado afectadas: solo responde GET', async () => {
    mockAuthenticated();

    const response = await request(buildApp({ findHistoricalDetail: async () => null }))
      .post('/matches/aaa/historical-detail')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(404);
  });
});
