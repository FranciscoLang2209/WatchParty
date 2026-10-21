-- Marcador real de los partidos (WAT-230): goles del local y del visitante
-- tal como los informa el proveedor (football-data.org: `score.fullTime`,
-- verificado contra la cuenta real el 19/10/2026).
--
-- Es aditiva: las dos columnas admiten NULL y los partidos existentes quedan
-- "sin resultado" hasta la próxima sincronización. NULL significa que no hay
-- marcador; nunca se rellena con 0, porque un 0–0 confirmado es un dato real.
alter table matches
    add column home_score smallint,
    add column away_score smallint,
    -- Un marcador a medias no es un marcador: o están los dos goles o ninguno.
    add constraint matches_score_complete check ((home_score is null) = (away_score is null)),
    add constraint matches_score_not_negative check (home_score >= 0 and away_score >= 0);

-- Nueva firma de upsert_match_fixture: suma los goles. Se elimina la anterior
-- para que no queden dos sobrecargas que PostgREST no sabría elegir. Los goles
-- tienen DEFAULT NULL para que un sync con el código anterior (diez argumentos)
-- siga guardando partidos durante el despliegue o tras un rollback.
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
  p_status text,
  p_home_score smallint default null,
  p_away_score smallint default null
) returns table(match_id uuid, was_inserted boolean)
language plpgsql
as $$
declare
v_home_team_id uuid;
  v_away_team_id uuid;
  v_match_id uuid;
  v_existing_id uuid;
  v_was_inserted boolean;
  v_home_score smallint := p_home_score;
  v_away_score smallint := p_away_score;
begin
-- Un marcador a medias no es un marcador: se descarta el par completo antes
-- del insert, porque Postgres valida matches_score_complete sobre la fila
-- propuesta aun cuando después termine en el UPDATE del conflicto.
if v_home_score is null or v_away_score is null then
    v_home_score := null;
    v_away_score := null;
end if;

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

select id into v_existing_id
from matches
where provider = p_provider and external_id = p_external_id;

v_was_inserted := v_existing_id is null;

insert into matches (
    provider, external_id, home_team_id, away_team_id,
    competition_external_id, season, kickoff_at, status,
    home_score, away_score
)
values (
           p_provider, p_external_id, v_home_team_id, v_away_team_id,
           p_competition_external_id, p_season, p_kickoff_at, p_status,
           v_home_score, v_away_score
       )
    on conflict (provider, external_id) do update set
    home_team_id = excluded.home_team_id,
                                               away_team_id = excluded.away_team_id,
                                               competition_external_id = excluded.competition_external_id,
                                               season = excluded.season,
                                               kickoff_at = excluded.kickoff_at,
                                               status = excluded.status,
                                               -- Un marcador ausente (o incompleto, ya descartado
                                               -- arriba) no borra uno guardado: el proveedor puede
                                               -- omitirlo en una respuesta puntual. Uno completo sí
                                               -- reemplaza al anterior (corrección). Se decide por
                                               -- el par, nunca gol por gol.
                                               home_score = case
                                                   when excluded.home_score is null then matches.home_score
                                                   else excluded.home_score
                                               end,
                                               away_score = case
                                                   when excluded.home_score is null then matches.away_score
                                                   else excluded.away_score
                                               end,
                                               updated_at = now()
                                               returning id into v_match_id;

return query select v_match_id, v_was_inserted;
end;
$$;

revoke execute on function public.upsert_match_fixture(
    text, text, text, text, text, text, text, text, timestamptz, text, smallint, smallint
    ) from public, anon, authenticated;

grant execute on function public.upsert_match_fixture(
  text, text, text, text, text, text, text, text, timestamptz, text, smallint, smallint
) to service_role;
