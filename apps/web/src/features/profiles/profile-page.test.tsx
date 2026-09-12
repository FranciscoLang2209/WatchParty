import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const API_BASE = 'https://api.watchparty.test';
const TOKEN = 'token-abc';

const { authMock, signOutMock } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() },
  signOutMock: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({ supabase: { auth: authMock } }));
vi.mock('../../lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  }),
}));

const session = { access_token: TOKEN, user: { id: 'user-1', email: 'a@b.com' } } as Session;

// La página consume la sesión por `useAuth`: acá se le da una ya resuelta para
// no reimplementar el AuthProvider en cada caso.
vi.mock('../../auth/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    session,
    user: session.user,
    signOut: signOutMock,
    isSigningOut: false,
    isRecovering: false,
    endRecovery: vi.fn(),
  }),
}));

const { ProfilePage } = await import('./ProfilePage');

const RIVER = '3f1a2b4c-0000-4000-8000-000000000001';
const BOCA = '3f1a2b4c-0000-4000-8000-000000000002';

const perfil = { displayName: 'Martina', bio: 'Hincha de siempre.', favoriteTeamId: RIVER };

const equipos = [
  { id: RIVER, name: 'River Plate' },
  { id: BOCA, name: 'Boca Juniors' },
];

const fetchMock = vi.fn();

interface Escenario {
  profile?: unknown;
  teams?: unknown;
  profileStatus?: number;
  teamsStatus?: number;
  /** Lo que responde el PUT. Por defecto, lo que se mandó. */
  saved?: unknown;
  saveStatus?: number;
}

function jsonResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function stubApi(escenario: Escenario = {}) {
  const {
    profile = perfil,
    teams = equipos,
    profileStatus = 200,
    teamsStatus = 200,
    saved,
    saveStatus = 200,
  } = escenario;

  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';

    if (method === 'PUT') {
      const enviado: unknown = JSON.parse(init?.body as string);

      return Promise.resolve(
        jsonResponse(
          saveStatus >= 400
            ? { error: { code: saveStatus === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' } }
            : { profile: saved ?? enviado },
          saveStatus,
        ),
      );
    }

    if (String(url).endsWith('/teams')) {
      return Promise.resolve(
        jsonResponse(
          teamsStatus >= 400 ? { error: { code: 'INTERNAL_ERROR' } } : { teams },
          teamsStatus,
        ),
      );
    }

    return Promise.resolve(
      jsonResponse(
        profileStatus >= 400
          ? { error: { code: profileStatus === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR' } }
          : { profile },
        profileStatus,
      ),
    );
  });
}

function renderPage() {
  const user = userEvent.setup();

  const view = render(
    <MemoryRouter initialEntries={['/profile']}>
      <ProfilePage />
    </MemoryRouter>,
  );

  return { user, view };
}

const nombre = () => screen.getByLabelText('Nombre visible');
const biografia = () => screen.getByLabelText('Biografía');
const favorito = () => screen.getByLabelText('Equipo favorito');
const guardar = () => screen.getByRole('button', { name: 'Guardar cambios' });

/** Cuerpo del último PUT. */
function guardado(): Record<string, unknown> {
  const put = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1);

  return JSON.parse(put![1].body as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProfilePage: la carga', () => {
  it('anuncia que está cargando', () => {
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Cargando tu perfil…');
  });

  it('consulta únicamente la Node API, con bearer', async () => {
    renderPage();
    await screen.findByLabelText('Nombre visible');

    const urls = fetchMock.mock.calls.map(([url]) => String(url));

    expect(urls).toContain(`${API_BASE}/me/profile`);
    expect(urls).toContain(`${API_BASE}/teams`);
    // Ni Supabase Data API ni partidos: los equipos salen de /teams.
    expect(urls.some((url) => url.includes('supabase'))).toBe(false);
    expect(urls.some((url) => url.includes('/matches'))).toBe(false);

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('muestra el perfil que devuelve la API', async () => {
    renderPage();

    expect(await screen.findByLabelText('Nombre visible')).toHaveValue('Martina');
    expect(biografia()).toHaveValue('Hincha de siempre.');
    expect(favorito()).toHaveValue(RIVER);
  });

  it('lista los equipos que devuelve la API', async () => {
    renderPage();
    await screen.findByLabelText('Equipo favorito');

    const opciones = within(favorito()).getAllByRole('option');

    expect(opciones.map((opcion) => opcion.textContent)).toEqual([
      'Sin equipo favorito',
      'River Plate',
      'Boca Juniors',
    ]);
  });
});

describe('ProfilePage: todavía no hay perfil', () => {
  beforeEach(() => {
    stubApi({ profile: null });
  });

  it('ofrece completarlo con el formulario vacío', async () => {
    renderPage();

    expect(await screen.findByLabelText('Nombre visible')).toHaveValue('');
    expect(biografia()).toHaveValue('');
    expect(favorito()).toHaveValue('');
    expect(screen.getByText(/Todavía no completaste tu perfil/)).toBeInTheDocument();
  });

  it('no lo presenta como un fallo', async () => {
    renderPage();
    await screen.findByLabelText('Nombre visible');

    // Ausencia de perfil no es error: ni alerta ni botón de reintento.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('deja guardar por primera vez', async () => {
    const { user } = renderPage();
    await screen.findByLabelText('Nombre visible');

    await user.type(nombre(), 'Martina');
    await user.click(guardar());

    await waitFor(() => expect(guardado()).toMatchObject({ displayName: 'Martina' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Guardamos tu perfil.');
  });
});

describe('ProfilePage: los fallos', () => {
  it('muestra el error y ofrece reintentar', async () => {
    stubApi({ profileStatus: 500 });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar tu perfil.');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    // Un fallo nunca se presenta como «todavía no tenés perfil».
    expect(screen.queryByLabelText('Nombre visible')).not.toBeInTheDocument();
    expect(screen.queryByText(/Todavía no completaste tu perfil/)).not.toBeInTheDocument();
  });

  it('falla también si no puede traer los equipos', async () => {
    stubApi({ teamsStatus: 500 });

    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('el reintento vuelve a consultar y se recupera', async () => {
    stubApi({ profileStatus: 500 });

    const { user } = renderPage();
    await screen.findByRole('alert');

    stubApi();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByLabelText('Nombre visible')).toHaveValue('Martina');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('la sesión vencida reingresa por el flujo de Auth existente', async () => {
    stubApi({ profileStatus: 401 });

    const { user } = renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció.');

    await user.click(screen.getByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });
});

describe('ProfilePage: guardar', () => {
  it('manda los tres campos y refleja exactamente lo que responde la API', async () => {
    // El backend normaliza: lo que se ve después es su respuesta, no lo tipeado.
    stubApi({
      saved: { displayName: 'Martina C.', bio: 'Normalizada.', favoriteTeamId: BOCA },
    });

    const { user } = renderPage();
    await screen.findByLabelText('Nombre visible');

    await user.clear(nombre());
    await user.type(nombre(), 'martina   ');
    await user.click(guardar());

    await waitFor(() => expect(nombre()).toHaveValue('Martina C.'));
    expect(biografia()).toHaveValue('Normalizada.');
    expect(favorito()).toHaveValue(BOCA);
  });

  it('quita el equipo favorito con favoriteTeamId null', async () => {
    const { user } = renderPage();
    await screen.findByLabelText('Equipo favorito');

    await user.selectOptions(favorito(), '');
    await user.click(guardar());

    await waitFor(() => expect(guardado().favoriteTeamId).toBeNull());
    expect(favorito()).toHaveValue('');
  });

  it('elige un equipo favorito distinto', async () => {
    const { user } = renderPage();
    await screen.findByLabelText('Equipo favorito');

    await user.selectOptions(favorito(), BOCA);
    await user.click(guardar());

    await waitFor(() => expect(guardado().favoriteTeamId).toBe(BOCA));
  });

  it('exige el nombre visible antes de molestar a la API', async () => {
    stubApi({ profile: null });

    const { user } = renderPage();
    await screen.findByLabelText('Nombre visible');

    await user.click(guardar());

    expect(await screen.findByRole('alert')).toHaveTextContent('El nombre visible es obligatorio.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('presenta el rechazo del backend sin vaciar el formulario', async () => {
    stubApi({ saveStatus: 400 });

    const { user } = renderPage();
    await screen.findByLabelText('Nombre visible');

    await user.click(guardar());

    expect(await screen.findByRole('alert')).toHaveTextContent('Revisá los datos');
    // Lo escrito no se pierde y se puede corregir.
    expect(nombre()).toHaveValue('Martina');
    expect(guardar()).toBeEnabled();
  });

  it('comunica el guardado pendiente y no permite un segundo envío', async () => {
    const { user } = renderPage();
    await screen.findByLabelText('Nombre visible');

    fetchMock.mockImplementation(() => new Promise(() => {}));
    await user.click(guardar());

    const pendiente = await screen.findByRole('button', { name: 'Guardando…' });

    expect(pendiente).toBeDisabled();
    expect(nombre()).toBeDisabled();

    await user.click(pendiente);

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  it('una recarga vuelve a mostrar lo que responde la API', async () => {
    const { user, view } = renderPage();
    await screen.findByLabelText('Nombre visible');

    await user.selectOptions(favorito(), BOCA);
    await user.click(guardar());
    await waitFor(() => expect(guardado().favoriteTeamId).toBe(BOCA));

    // La recarga simulada: se desmonta y se vuelve a pedir a la API.
    stubApi({ profile: { ...perfil, favoriteTeamId: BOCA } });
    view.unmount();
    renderPage();

    expect(await screen.findByLabelText('Equipo favorito')).toHaveValue(BOCA);
  });
});

describe('ProfilePage: teclado', () => {
  it('recorre formulario, selector y guardar en orden', async () => {
    const { user } = renderPage();
    await screen.findByLabelText('Nombre visible');

    await user.tab();
    expect(nombre()).toHaveFocus();

    await user.tab();
    expect(biografia()).toHaveFocus();

    await user.tab();
    expect(favorito()).toHaveFocus();

    await user.tab();
    expect(guardar()).toHaveFocus();
  });
});
