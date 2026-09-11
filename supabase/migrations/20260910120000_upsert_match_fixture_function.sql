-- Guarda un fixture completo (dos equipos + partido) de forma atómica.
-- Reemplaza la lógica que antes vivía en el cliente (SupabaseMatchStore
-- hacía 3 upserts HTTP separados): si el paso del partido fallaba —por
-- ejemplo por violar matches_distinct_teams cuando home == away—, los
-- equipos ya habían quedado confirmados en la base. Al mover las 3
-- escrituras acá adentro, todas corren dentro de la transacción implícita
-- de esta única sentencia: si algo lanza excepción, Postgres revierte
-- también los upserts de equipos que ya se hayan ejecutado en esta misma
-- invocación.
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
) returns uuid
language plpgsql
as $$
declare
v_home_team_id uuid;
v_away_team_id uuid;
v_match_id uuid;
begin
-- Equipos antes que partido: el partido referencia a ambos por FK.
-- No incluimos `id` en ningún insert: en el insert lo genera el default
-- (gen_random_uuid()); en conflicto, el UPDATE solo toca las columnas
-- listadas, así que el id existente nunca cambia (misma idempotencia que
-- ya teníamos, ahora atómica).
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

-- Si esto falla (por ejemplo matches_distinct_teams cuando
-- v_home_team_id = v_away_team_id), la excepción aborta toda la función:
-- los dos upserts de teams de arriba también se revierten.
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

return v_match_id;
end;
$$;

-- Misma política que las funciones de lease de WAT-103: de uso exclusivo
-- del backend (Node) vía service_role key, nunca invocable por anon ni
-- authenticated.
revoke execute on function public.upsert_match_fixture(
    text, text, text, text, text, text, text, text, timestamptz, text
    ) from public, anon, authenticated;

grant execute on function public.upsert_match_fixture(
  text, text, text, text, text, text, text, text, timestamptz, text
) to service_role;