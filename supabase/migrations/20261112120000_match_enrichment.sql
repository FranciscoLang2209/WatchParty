-- Enriquecimiento histórico de partidos ya guardados (estadísticas y goles de un proveedor
-- complementario). Migración ADITIVA: no toca `matches` ni `teams`. El partido conserva su UUID,
-- su `(provider, external_id)` y su marcador; todo lo nuevo cuelga de `matches.id`.

-- 1) Correspondencia estable «partido interno ↔ fixture del proveedor complementario».
--    Los ids externos de proveedores distintos NO son comunes: la vinculación es explícita.
create table match_provider_links (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id),
  provider text not null,
  external_fixture_id text not null,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Un partido tiene a lo sumo un fixture por proveedor...
  constraint match_provider_links_match_provider_key unique (match_id, provider),
  -- ...y un fixture externo no puede asociarse a dos partidos internos.
  constraint match_provider_links_provider_fixture_key unique (provider, external_fixture_id),
  constraint match_provider_links_provider_not_blank check (btrim(provider) <> ''),
  constraint match_provider_links_fixture_not_blank check (btrim(external_fixture_id) <> '')
);

-- 2) Estado del enriquecimiento por partido y proveedor: qué se guardó, con qué cobertura y cuándo
--    se consultó. Sin fila = el partido nunca se enriqueció.
--    statistics_coverage: complete (los dos equipos y las cinco métricas) | partial (falta algo).
--    goals_coverage: complete (la cronología coincide con el marcador) | incomplete (no coincide).
create table match_enrichment (
  match_id uuid not null references matches(id),
  provider text not null,
  statistics_coverage text,
  statistics_fetched_at timestamptz,
  goals_coverage text,
  goals_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (match_id, provider),
  constraint match_enrichment_provider_not_blank check (btrim(provider) <> ''),
  constraint match_enrichment_statistics_coverage_check
    check (statistics_coverage is null or statistics_coverage in ('complete', 'partial')),
  constraint match_enrichment_goals_coverage_check
    check (goals_coverage is null or goals_coverage in ('complete', 'incomplete')),
  constraint match_enrichment_statistics_consistency
    check ((statistics_coverage is null) = (statistics_fetched_at is null)),
  constraint match_enrichment_goals_consistency
    check ((goals_coverage is null) = (goals_fetched_at is null))
);

-- 3) Estadísticas por equipo. Cada métrica es NULL cuando el proveedor no la informó: un NULL
--    nunca se convierte en cero (un 0 es un dato real).
create table match_team_statistics (
  match_id uuid not null,
  provider text not null,
  side text not null,
  possession_pct numeric(5, 2),
  total_shots smallint,
  shots_on_goal smallint,
  corner_kicks smallint,
  fouls smallint,
  primary key (match_id, provider, side),
  foreign key (match_id, provider) references match_enrichment (match_id, provider) on delete cascade,
  constraint match_team_statistics_side_check check (side in ('home', 'away')),
  constraint match_team_statistics_possession_range
    check (possession_pct is null or (possession_pct >= 0 and possession_pct <= 100)),
  constraint match_team_statistics_counts_not_negative
    check (
      (total_shots is null or total_shots >= 0)
      and (shots_on_goal is null or shots_on_goal >= 0)
      and (corner_kicks is null or corner_kicks >= 0)
      and (fouls is null or fouls >= 0)
    )
);

-- 4) Cronología de goles, en el orden en que la entrega el proveedor (`position`).
--    kind separa los goles del juego, las anulaciones y la tanda de penales:
--      goal | own_goal | penalty_goal   -> goles del juego
--      goal_cancelled                   -> anulación (VAR); no suma al marcador
--      shootout_goal                    -> gol de la tanda de penales; no es un gol del juego
--    `side` es el equipo al que se le acredita (en un gol en contra, el beneficiado).
--    `minute` y `extra_minute` guardan el minuto y el añadido por separado (45 + 2, 90 + 4).
create table match_goal_events (
  match_id uuid not null,
  provider text not null,
  position smallint not null,
  kind text not null,
  side text not null,
  player_name text,
  minute smallint not null,
  extra_minute smallint,
  primary key (match_id, provider, position),
  foreign key (match_id, provider) references match_enrichment (match_id, provider) on delete cascade,
  constraint match_goal_events_kind_check
    check (kind in ('goal', 'own_goal', 'penalty_goal', 'goal_cancelled', 'shootout_goal')),
  constraint match_goal_events_side_check check (side in ('home', 'away')),
  constraint match_goal_events_position_not_negative check (position >= 0),
  constraint match_goal_events_minute_range check (minute >= 0 and minute <= 200),
  constraint match_goal_events_extra_range check (extra_minute is null or (extra_minute >= 0 and extra_minute <= 60)),
  constraint match_goal_events_player_not_blank check (player_name is null or btrim(player_name) <> '')
);

alter table match_provider_links enable row level security;
alter table match_enrichment enable row level security;
alter table match_team_statistics enable row level security;
alter table match_goal_events enable row level security;

create trigger match_provider_links_set_updated_at
  before update on match_provider_links
  for each row
  execute function public.set_updated_at();

create trigger match_enrichment_set_updated_at
  before update on match_enrichment
  for each row
  execute function public.set_updated_at();

-- Mismo criterio que `matches`: sin acceso directo para anon/authenticated. La API (service_role)
-- es quien lee y escribe; el frontend nunca consulta estas tablas.
revoke all privileges on table public.match_provider_links from anon, authenticated;
revoke all privileges on table public.match_enrichment from anon, authenticated;
revoke all privileges on table public.match_team_statistics from anon, authenticated;
revoke all privileges on table public.match_goal_events from anon, authenticated;

grant all privileges on table public.match_provider_links to service_role;
grant all privileges on table public.match_enrichment to service_role;
grant all privileges on table public.match_team_statistics to service_role;
grant all privileges on table public.match_goal_events to service_role;

-- Guardado atómico del enriquecimiento de UN partido existente (PostgREST no tiene transacciones:
-- borrar y reinsertar desde la API dejaría datos a medias si algo falla en el medio).
--
--   p_statistics / p_goals son opcionales: NULL significa «no tocar esa parte». Así una respuesta
--   incompleta o con error nunca borra lo ya confirmado; la decisión de qué reemplazar la toma
--   el importador y esta función sólo la ejecuta de forma atómica.
--   p_statistics = {"coverage": "complete|partial", "home": {...}, "away": {...}}
--   p_goals      = {"coverage": "complete|incomplete", "events": [{kind, side, player_name,
--                   minute, extra_minute}, ...]}  (el orden del arreglo es el orden de `position`)
--
-- Un partido que no existe es un error (no se crea nada). Si el partido ya está vinculado a OTRO
-- fixture del proveedor, o el fixture ya pertenece a otro partido, falla: el vínculo no se
-- reasigna en silencio.
create or replace function apply_match_enrichment(
  p_match_id uuid,
  p_provider text,
  p_external_fixture_id text,
  p_fetched_at timestamptz,
  p_statistics jsonb,
  p_goals jsonb
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_linked_fixture text;
  v_side text;
  v_event jsonb;
  v_position integer := 0;
begin
  if not exists (select 1 from matches where id = p_match_id) then
    raise exception 'El partido % no existe: no se crea ni se enriquece.', p_match_id;
  end if;

  select external_fixture_id into v_linked_fixture
  from match_provider_links
  where match_id = p_match_id and provider = p_provider;

  if v_linked_fixture is not null and v_linked_fixture <> p_external_fixture_id then
    raise exception 'El partido % ya está vinculado a otro fixture de %.', p_match_id, p_provider;
  end if;

  if v_linked_fixture is null then
    insert into match_provider_links (match_id, provider, external_fixture_id, verified_at)
    values (p_match_id, p_provider, p_external_fixture_id, p_fetched_at);
  else
    update match_provider_links
    set verified_at = p_fetched_at
    where match_id = p_match_id and provider = p_provider;
  end if;

  insert into match_enrichment (match_id, provider)
  values (p_match_id, p_provider)
  on conflict (match_id, provider) do nothing;

  if p_statistics is not null then
    delete from match_team_statistics where match_id = p_match_id and provider = p_provider;

    foreach v_side in array array['home', 'away'] loop
      if p_statistics -> v_side is not null and jsonb_typeof(p_statistics -> v_side) = 'object' then
        insert into match_team_statistics (
          match_id, provider, side, possession_pct, total_shots, shots_on_goal, corner_kicks, fouls
        )
        values (
          p_match_id,
          p_provider,
          v_side,
          (p_statistics -> v_side ->> 'possession_pct')::numeric,
          (p_statistics -> v_side ->> 'total_shots')::smallint,
          (p_statistics -> v_side ->> 'shots_on_goal')::smallint,
          (p_statistics -> v_side ->> 'corner_kicks')::smallint,
          (p_statistics -> v_side ->> 'fouls')::smallint
        );
      end if;
    end loop;

    update match_enrichment
    set statistics_coverage = p_statistics ->> 'coverage',
        statistics_fetched_at = p_fetched_at
    where match_id = p_match_id and provider = p_provider;
  end if;

  if p_goals is not null then
    delete from match_goal_events where match_id = p_match_id and provider = p_provider;

    for v_event in select * from jsonb_array_elements(coalesce(p_goals -> 'events', '[]'::jsonb)) loop
      insert into match_goal_events (
        match_id, provider, position, kind, side, player_name, minute, extra_minute
      )
      values (
        p_match_id,
        p_provider,
        v_position,
        v_event ->> 'kind',
        v_event ->> 'side',
        nullif(btrim(v_event ->> 'player_name'), ''),
        (v_event ->> 'minute')::smallint,
        (v_event ->> 'extra_minute')::smallint
      );

      v_position := v_position + 1;
    end loop;

    update match_enrichment
    set goals_coverage = p_goals ->> 'coverage',
        goals_fetched_at = p_fetched_at
    where match_id = p_match_id and provider = p_provider;
  end if;
end;
$$;

revoke execute on function public.apply_match_enrichment(uuid, text, text, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_match_enrichment(uuid, text, text, timestamptz, jsonb, jsonb)
  to service_role;
