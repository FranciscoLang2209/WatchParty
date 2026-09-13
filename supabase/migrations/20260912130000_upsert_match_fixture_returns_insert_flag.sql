-- Extiende upsert_match_fixture (WAT-106) para que además informe si el
-- partido fue creado o actualizado. Necesario para que el comando de
-- sincronización (WAT-107) pueda contar "importados" vs "actualizados"
-- por separado en su resumen — el `uuid` solo no alcanza para eso.
drop function if exists upsert_match_fixture(
    text, text, text, text, text, text, text, text, timestamptz, text
    );

create or replace function upsert_match_fixture(
  p_provider text,
  p_external_id text,
  p_home_team_external_id text,
  p_home_team_name text,
  p_away_team_external_id text,
  p_away_team_name text,
  p_competition_external_id text,
  p_season text,
  p_kickoff_at timestamptz,
  p_status text
) returns table(match_id uuid, was_inserted boolean)
language plpgsql
as $$
declare
v_home_team_id uuid;
  v_away_team_id uuid;
  v_match_id uuid;
  v_existing_id uuid;
  v_was_inserted boolean;
begin
insert into teams (provider, external_id, name)
values (p_provider, p_home_team_external_id, p_home_team_name)
    on conflict (provider, external_id) do update set
    name = excluded.name,
                                               updated_at = now()
                                               returning id into v_home_team_id;

insert into teams (provider, external_id, name)
values (p_provider, p_away_team_external_id, p_away_team_name)
    on conflict (provider, external_id) do update set
    name = excluded.name,
                                               updated_at = now()
                                               returning id into v_away_team_id;

-- Se chequea ANTES del upsert, dentro de la misma ejecución de la
-- función (mismo statement atómico) — más explícito y verificable que
-- inferirlo de columnas de sistema de Postgres.
select id into v_existing_id
from matches
where provider = p_provider and external_id = p_external_id;

v_was_inserted := v_existing_id is null;

insert into matches (
    provider, external_id, home_team_id, away_team_id,
    competition_external_id, season, kickoff_at, status
)
values (
           p_provider, p_external_id, v_home_team_id, v_away_team_id,
           p_competition_external_id, p_season, p_kickoff_at, p_status
       )
    on conflict (provider, external_id) do update set
    home_team_id = excluded.home_team_id,
                                               away_team_id = excluded.away_team_id,
                                               competition_external_id = excluded.competition_external_id,
                                               season = excluded.season,
                                               kickoff_at = excluded.kickoff_at,
                                               status = excluded.status,
                                               updated_at = now()
                                               returning id into v_match_id;

return query select v_match_id, v_was_inserted;
end;
$$;

revoke execute on function public.upsert_match_fixture(
    text, text, text, text, text, text, text, text, timestamptz, text
    ) from public, anon, authenticated;

grant execute on function public.upsert_match_fixture(
  text, text, text, text, text, text, text, text, timestamptz, text
) to service_role;