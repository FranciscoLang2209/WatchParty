-- Tabla de equipos, identificados de forma estable por proveedor externo.
create table teams (
                       id uuid primary key default gen_random_uuid(),
                       provider text not null,
                       external_id text not null,
                       name text not null,
                       created_at timestamptz not null default now(),
                       updated_at timestamptz not null default now(),
                       constraint teams_provider_external_id_key unique (provider, external_id),
                       constraint teams_provider_not_blank check (btrim(provider) <> ''),
                       constraint teams_external_id_not_blank check (btrim(external_id) <> ''),
                       constraint teams_name_not_blank check (btrim(name) <> '')
);
alter table teams enable row level security;

-- Tabla de partidos. El estado está limitado al contrato canónico de Match
-- (apps/api/src/modules/matches/domain/match.ts) y no debe divergir de él.
create table matches (
                         id uuid primary key default gen_random_uuid(),
                         provider text not null,
                         external_id text not null,
                         home_team_id uuid not null references teams(id),
                         away_team_id uuid not null references teams(id),
                         competition_external_id text not null,
                         season text not null,
                         kickoff_at timestamptz not null,
                         status text not null check (status in ('scheduled', 'live', 'finished', 'postponed', 'cancelled')),
                         created_at timestamptz not null default now(),
                         updated_at timestamptz not null default now(),
                         constraint matches_provider_external_id_key unique (provider, external_id),
                         constraint matches_distinct_teams check (home_team_id <> away_team_id),
                         constraint matches_provider_not_blank check (btrim(provider) <> ''),
                         constraint matches_external_id_not_blank check (btrim(external_id) <> ''),
                         constraint matches_competition_external_id_not_blank check (btrim(competition_external_id) <> ''),
                         constraint matches_season_not_blank check (btrim(season) <> '')
);

create index matches_kickoff_at_idx on matches (kickoff_at);
create index matches_status_idx on matches (status);
-- Postgres no crea automáticamente índices para columnas de FK: sin estos,
-- cualquier lookup o join por equipo (local o visitante) hace un seq scan.
create index matches_home_team_id_idx on matches (home_team_id);
create index matches_away_team_id_idx on matches (away_team_id);

alter table matches enable row level security;


-- Estado de sincronización con un proveedor externo, por competición y temporada.
-- Nunca almacena API keys, tokens del proveedor ni respuestas completas.
create table provider_sync_state (
                                     id uuid primary key default gen_random_uuid(),
                                     provider text not null,
                                     competition_external_id text not null,
                                     season text not null,
                                     last_attempt_at timestamptz,
                                     last_success_at timestamptz,
                                     last_error text,
                                     observed_quota_remaining integer,
                                     observed_quota_window_reset_at timestamptz,
                                     lease_owner text,
                                     lease_token uuid,
                                     lease_expires_at timestamptz,
                                     created_at timestamptz not null default now(),
                                     updated_at timestamptz not null default now(),
                                     constraint provider_sync_state_scope_key unique (provider, competition_external_id, season),
                                     constraint provider_sync_state_provider_not_blank check (btrim(provider) <> ''),
                                     constraint provider_sync_state_competition_external_id_not_blank check (btrim(competition_external_id) <> ''),
                                     constraint provider_sync_state_season_not_blank check (btrim(season) <> ''),
                                     constraint provider_sync_state_quota_not_negative check (
                                         observed_quota_remaining is null or observed_quota_remaining >= 0
                                     ),
                                     -- Evita estados de lease incompletos: o está completamente libre
                                     -- (sin owner, token ni vencimiento), o completamente tomado (los tres
                                     -- valores presentes). Las funciones de lease de
                                     -- 20260904224942_provider_sync_lease_functions.sql ya respetan esto,
                                     -- pero el constraint protege contra futuras escrituras directas con
                                     -- service_role que dejen la fila en un estado inconsistente.
                                     constraint provider_sync_state_lease_consistency check (
                                         (
                                             lease_owner is null
                                             and lease_token is null
                                             and lease_expires_at is null
                                         )
                                         or
                                         (
                                             lease_owner is not null
                                             and lease_token is not null
                                             and lease_expires_at is not null
                                         )
                                     )
);
alter table provider_sync_state enable row level security;

-- Mantiene updated_at al día en cualquier UPDATE sobre las tres tablas.
-- Las funciones de lease ya lo actualizan explícitamente, pero esto cubre
-- también futuras escrituras directas (por ejemplo, cuando WAT-106 actualice
-- equipos o partidos) sin depender de que cada caller se acuerde de hacerlo.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger teams_set_updated_at
  before update on teams
  for each row
  execute function public.set_updated_at();

create trigger matches_set_updated_at
  before update on matches
  for each row
  execute function public.set_updated_at();

create trigger provider_sync_state_set_updated_at
  before update on provider_sync_state
  for each row
  execute function public.set_updated_at();

-- RLS solo controla qué filas puede ver/tocar un rol que YA tiene permiso
-- para operar sobre la tabla. Sin políticas, anon/authenticated no ven filas,
-- pero eso no revoca el permiso de intentar la operación a nivel de tabla.
-- El ticket pide que no haya acceso directo desde anon ni authenticated, y
-- que el único acceso privilegiado sea desde Node con la service_role key:
-- por eso además de RLS, revocamos los privilegios de tabla explícitamente.
revoke all privileges on table public.teams from anon, authenticated;
revoke all privileges on table public.matches from anon, authenticated;
revoke all privileges on table public.provider_sync_state from anon, authenticated;

grant all privileges on table public.teams to service_role;
grant all privileges on table public.matches to service_role;
grant all privileges on table public.provider_sync_state to service_role;
