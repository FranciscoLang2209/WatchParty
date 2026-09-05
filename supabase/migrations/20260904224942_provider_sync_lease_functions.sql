-- Funciones de coordinación para la futura sincronización con un proveedor
-- deportivo externo. No consultan ninguna API ni conocen datos de fútbol:
-- solo gestionan el "lease" (turno exclusivo y con vencimiento) que evita
-- que dos sincronizaciones para la misma competición/temporada se pisen,
-- y registran cómo terminó cada intento.


-- Adquiere el lease de forma atómica: solo si está libre (nunca tomado,
-- o ya liberado/recuperado). No "roba" un lease vencido — para eso está
-- reclaim_expired_provider_sync_lease.
create or replace function acquire_provider_sync_lease(
  p_provider text,
  p_competition_external_id text,
  p_season text,
  p_owner text,
  p_lease_duration interval default interval '15 minutes'
) returns uuid
language plpgsql
as $$
declare
v_lease_token uuid := gen_random_uuid();
begin
insert into provider_sync_state (
    provider, competition_external_id, season,
    last_attempt_at, lease_owner, lease_token, lease_expires_at
)
values (
           p_provider, p_competition_external_id, p_season,
           now(), p_owner, v_lease_token, now() + p_lease_duration
       )
    on conflict (provider, competition_external_id, season)
  do update set
    last_attempt_at = now(),
             lease_owner = p_owner,
             lease_token = v_lease_token,
             lease_expires_at = now() + p_lease_duration,
             updated_at = now()
     where provider_sync_state.lease_token is null;

if not found then
    return null;
end if;

return v_lease_token;
end;
$$;

-- Libera un lease vencido para que quede disponible de nuevo.
-- No hace nada si el lease sigue vigente.
create or replace function reclaim_expired_provider_sync_lease(
  p_provider text,
  p_competition_external_id text,
  p_season text
) returns boolean
language plpgsql
as $$
begin
update provider_sync_state
set lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where provider = p_provider
  and competition_external_id = p_competition_external_id
  and season = p_season
  and lease_expires_at is not null
  and lease_expires_at < now();

return found;
end;
$$;

-- Libera un lease vigente, solo si el token coincide con el dueño actual.
create or replace function release_provider_sync_lease(
  p_provider text,
  p_competition_external_id text,
  p_season text,
  p_lease_token uuid
) returns boolean
language plpgsql
as $$
begin
update provider_sync_state
set lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where provider = p_provider
  and competition_external_id = p_competition_external_id
  and season = p_season
  and lease_token = p_lease_token;

return found;
end;
$$;

-- Registra el resultado de un intento de sincronización y libera el lease
-- (el intento termina acá). Exige el token del lease vigente.
create or replace function record_provider_sync_result(
  p_provider text,
  p_competition_external_id text,
  p_season text,
  p_lease_token uuid,
  p_success boolean,
  p_error text default null,
  p_observed_quota_remaining integer default null,
  p_observed_quota_window_reset_at timestamptz default null
) returns boolean
language plpgsql
as $$
begin
update provider_sync_state
set last_attempt_at = now(),
    last_success_at = case when p_success then now() else last_success_at end,
    last_error = case when p_success then null else p_error end,
    observed_quota_remaining = coalesce(p_observed_quota_remaining, observed_quota_remaining),
    observed_quota_window_reset_at = coalesce(p_observed_quota_window_reset_at, observed_quota_window_reset_at),
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where provider = p_provider
  and competition_external_id = p_competition_external_id
  and season = p_season
  and lease_token = p_lease_token;

return found;
end;
$$;