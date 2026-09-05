-- Tabla de equipos, identificados de forma estable por proveedor externo.
create table teams (
                       id uuid primary key default gen_random_uuid(),
                       provider text not null,
                       external_id text not null,
                       name text not null,
                       created_at timestamptz not null default now(),
                       updated_at timestamptz not null default now(),
                       constraint teams_provider_external_id_key unique (provider, external_id)
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
                         constraint matches_distinct_teams check (home_team_id <> away_team_id)
);

create index matches_kickoff_at_idx on matches (kickoff_at);
create index matches_status_idx on matches (status);

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
                                     constraint provider_sync_state_scope_key unique (provider, competition_external_id, season)
);
alter table provider_sync_state enable row level security;