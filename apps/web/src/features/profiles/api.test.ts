import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOwnProfile, listTeams, saveOwnProfile } from './api';
import { ProfilesApiError, isCancelled, isUnauthorized, type ProfileInput } from './types';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../../lib/env', () => ({ readWebEnv: envMock }));

const perfil = {
  displayName: 'Martina',
  bio: 'Hincha de siempre.',
  favoriteTeamId: '3f1a2b4c-0000-4000-8000-000000000001',
};

const equipo = { id: '3f1a2b4c-0000-4000-8000-000000000001', name: 'River Plate' };

const entrada: ProfileInput = {
  displayName: 'Martina',
  bio: 'Hincha de siempre.',
  favoriteTeamId: '3f1a2b4c-0000-4000-8000-000000000001',
};

const fetchMock = vi.fn();

function respondWith(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;

  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function requestUrl(): string {
  return fetchMock.mock.calls[0]![0] as string;
}

function requestInit(): RequestInit {
  return fetchMock.mock.calls[0]![1] as RequestInit;
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.mockReturnValue({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOwnProfile', () => {
  it('consulta GET /me/profile con bearer', async () => {
    respondWith({ profile: perfil });

    await getOwnProfile(TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/me/profile`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('arma la URL sin barra doble aunque la base termine en /', async () => {
    envMock.mockReturnValue({
      supabaseUrl: 'https://supabase.test',
      supabaseAnonKey: 'anon',
      apiBaseUrl: `${API_BASE}///`,
    });
    respondWith({ profile: perfil });

    await getOwnProfile(TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/me/profile`);
  });

  it('devuelve los tres campos del perfil', async () => {
    respondWith({ profile: perfil });

    await expect(getOwnProfile(TOKEN)).resolves.toEqual(perfil);
  });

  it('descarta los campos internos que el backend no debería mandar', async () => {
    respondWith({
      profile: { ...perfil, userId: 'user-1', createdAt: '2026-09-10T00:00:00Z' },
    });

    const resultado = await getOwnProfile(TOKEN);

    // El contrato son tres campos: nada de userId ni timestamps llega a la UI.
    expect(Object.keys(resultado ?? {}).sort()).toEqual(['bio', 'displayName', 'favoriteTeamId']);
  });

  it('devuelve null cuando todavía no hay perfil', async () => {
    respondWith({ profile: null });

    // Ausencia de perfil no es un fallo: es una respuesta válida del contrato.
    await expect(getOwnProfile(TOKEN)).resolves.toBeNull();
  });

  it('acepta un perfil sin equipo favorito', async () => {
    respondWith({ profile: { ...perfil, favoriteTeamId: null } });

    await expect(getOwnProfile(TOKEN)).resolves.toEqual({ ...perfil, favoriteTeamId: null });
  });

  it('rechaza un envelope sin la clave profile', async () => {
    respondWith({ perfil });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un perfil con campos del tipo equivocado', async () => {
    respondWith({ profile: { ...perfil, displayName: 42 } });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un favoriteTeamId que no es ni texto ni null', async () => {
    respondWith({ profile: { ...perfil, favoriteTeamId: 7 } });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('listTeams', () => {
  it('consulta GET /teams con bearer', async () => {
    respondWith({ teams: [equipo] });

    await listTeams(TOKEN);

    expect(requestUrl()).toBe(`${API_BASE}/teams`);
    expect(requestInit().method).toBe('GET');
    expect(new Headers(requestInit().headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('devuelve id y nombre de cada equipo', async () => {
    respondWith({ teams: [equipo, { id: 'otro-id', name: 'Boca Juniors' }] });

    await expect(listTeams(TOKEN)).resolves.toEqual([
      equipo,
      { id: 'otro-id', name: 'Boca Juniors' },
    ]);
  });

  it('acepta una lista vacía', async () => {
    respondWith({ teams: [] });

    await expect(listTeams(TOKEN)).resolves.toEqual([]);
  });

  it('rechaza un envelope que no trae un arreglo', async () => {
    respondWith({ teams: { id: 'x', name: 'y' } });

    await expect(listTeams(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rechaza un equipo sin nombre', async () => {
    respondWith({ teams: [{ id: 'sin-nombre' }] });

    await expect(listTeams(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('saveOwnProfile', () => {
  it('manda PUT /me/profile con JSON y bearer', async () => {
    respondWith({ profile: perfil });

    await saveOwnProfile(entrada, TOKEN);

    const init = requestInit();
    const headers = new Headers(init.headers);

    expect(requestUrl()).toBe(`${API_BASE}/me/profile`);
    expect(init.method).toBe('PUT');
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(entrada);
  });

  it('manda favoriteTeamId null para quitar el favorito', async () => {
    respondWith({ profile: { ...perfil, favoriteTeamId: null } });

    await saveOwnProfile({ ...entrada, favoriteTeamId: null }, TOKEN);

    expect(JSON.parse(requestInit().body as string).favoriteTeamId).toBeNull();
  });

  it('devuelve exactamente el perfil que responde la API', async () => {
    // Lo que se ve después de guardar es la respuesta, no lo que se mandó.
    respondWith({ profile: { ...perfil, displayName: 'Normalizado' } });

    await expect(saveOwnProfile(entrada, TOKEN)).resolves.toEqual({
      ...perfil,
      displayName: 'Normalizado',
    });
  });

  it('rechaza un guardado que responde profile null', async () => {
    respondWith({ profile: null });

    // Un PUT exitoso siempre devuelve el perfil guardado, nunca null.
    await expect(saveOwnProfile(entrada, TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('distingue el 400 de validación del backend', async () => {
    respondWith({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });

    await expect(saveOwnProfile(entrada, TOKEN)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('el mapeo de errores', () => {
  it('traduce 401 a sesión vencida', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });

    await expect(getOwnProfile(TOKEN)).rejects.toSatisfy(isUnauthorized);
  });

  it('traduce 403 a sesión vencida', async () => {
    respondWith({}, { status: 403 });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('traduce 404 a no encontrado, que no es «sin perfil»', async () => {
    respondWith({ error: { code: 'NOT_FOUND' } }, { status: 404 });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('traduce 400 a inválido', async () => {
    respondWith({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('traduce 500 a error del servidor', async () => {
    respondWith({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('cae al status HTTP cuando el cuerpo no es el contrato de errores', async () => {
    // Un proxy devolviendo HTML no puede tumbar el mapeo.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'server' });
  });

  it('prefiere el código del contrato por sobre el status', async () => {
    respondWith({ error: { code: 'UNAUTHORIZED' } }, { status: 500 });

    await expect(getOwnProfile(TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('traduce un fallo de red', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(listTeams(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });

  it('distingue el abort de un fallo de red', async () => {
    fetchMock.mockRejectedValue(abortError());

    await expect(getOwnProfile(TOKEN)).rejects.toSatisfy(isCancelled);
  });

  it('propaga la señal de abort al fetch', async () => {
    const controller = new AbortController();
    respondWith({ profile: perfil });

    await getOwnProfile(TOKEN, controller.signal);

    expect(requestInit().signal).toBe(controller.signal);
  });

  it('no muestra el motivo interno: cada mensaje es presentable', async () => {
    respondWith(
      { error: { code: 'INTERNAL_ERROR', detail: 'pg: relation "profiles" missing' } },
      {
        status: 500,
      },
    );

    const error = await getOwnProfile(TOKEN).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProfilesApiError);
    expect((error as ProfilesApiError).message).not.toContain('pg:');
    expect((error as ProfilesApiError).message).not.toContain('relation');
  });

  it('el mensaje de cancelación no se muestra como fallo', async () => {
    fetchMock.mockRejectedValue(abortError());

    const error = await getOwnProfile(TOKEN).catch((caught: unknown) => caught);

    expect(isCancelled(error)).toBe(true);
  });
});
