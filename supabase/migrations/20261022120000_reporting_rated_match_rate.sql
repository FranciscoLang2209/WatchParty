-- KPI de negocio rated_match_rate (WAT-220, ADR-05 rev. 2.0). Agregado de
-- solo lectura para el reporter: devuelve un único número y nunca filas
-- personales. Es aditiva: crea objetos nuevos en el esquema reporting y no
-- modifica ninguna tabla existente.
--
-- El esquema reporting y el rol del reporter ya existen en producción
-- (WAT-192, fuera del repo, junto con reporting.catalog_match_count); en
-- local se crea vacío.
create schema if not exists reporting;

revoke all on schema reporting from public, anon, authenticated;

-- Cuentas técnicas (pruebas, demos, smoke): se excluyen de todas las
-- fuentes de los KPIs de negocio. Se cargan a mano con un rol privilegiado;
-- nadie más la lee. ON DELETE CASCADE: la fila solo marca al usuario, igual
-- que profiles.user_id.
create table reporting.technical_accounts (
    user_id uuid primary key references auth.users(id) on delete cascade,
    created_at timestamptz not null default now()
);

alter table reporting.technical_accounts enable row level security;

revoke all privileges on table reporting.technical_accounts from public, anon, authenticated;

-- Porcentaje de pares usuario–partido vistos en el mes argentino hasta el
-- corte T que además tienen, en ese mismo período, una nota o un comentario
-- del mismo usuario sobre el mismo partido.
--
-- - Denominador: watched_matches con created_at en [inicio del mes, T]. La
--   PK (user_id, match_id) ya garantiza un par por fila.
-- - Numerador: esos pares con una nota creada o editada en el período, o un
--   comentario en la sala del partido. EXISTS en vez de JOIN: varios
--   comentarios o nota + comentario no multiplican el par.
-- - Las cuentas técnicas se excluyen por usuario, así que tampoco aportan
--   notas ni comentarios.
--
-- Nunca inventa un cero: sin pares vistos devuelve value null con motivo
-- 'no-denominator', y con un corte nulo o futuro 'invalid-cutoff'. Con
-- denominador válido, value está entre 0 y 100 (unidad %) y el motivo es null.
--
-- SECURITY DEFINER con search_path vacío: el reporter solo puede ejecutar
-- esta función, no leer las tablas que agrega.
create function reporting.rated_match_rate(cutoff timestamptz)
returns table (value double precision, omission_reason text)
language sql
stable
security definer
set search_path = ''
as $$
    with period as (
        select
            (date_trunc('month', cutoff at time zone 'America/Argentina/Buenos_Aires')
                at time zone 'America/Argentina/Buenos_Aires') as starts_at,
            cutoff as ends_at
    ),
    watched_pairs as (
        select w.user_id, w.match_id
        from public.watched_matches w
        cross join period p
        where w.created_at >= p.starts_at
          and w.created_at <= p.ends_at
          and not exists (
              select 1 from reporting.technical_accounts t where t.user_id = w.user_id
          )
    ),
    totals as (
        select
            count(*) as watched,
            count(*) filter (
                where exists (
                    select 1
                    from public.match_ratings r
                    cross join period p
                    where r.user_id = wp.user_id
                      and r.match_id = wp.match_id
                      and (
                          (r.created_at >= p.starts_at and r.created_at <= p.ends_at)
                          or (r.updated_at >= p.starts_at and r.updated_at <= p.ends_at)
                      )
                )
                or exists (
                    select 1
                    from public.room_comments c
                    join public.rooms ro on ro.id = c.room_id
                    cross join period p
                    where c.author_id = wp.user_id
                      and ro.match_id = wp.match_id
                      and c.created_at >= p.starts_at
                      and c.created_at <= p.ends_at
                )
            ) as rated
        from watched_pairs wp
    )
    select
        case
            when cutoff is null or cutoff > now() then null
            when watched = 0 then null
            else 100.0 * rated / watched
        end,
        case
            when cutoff is null or cutoff > now() then 'invalid-cutoff'
            when watched = 0 then 'no-denominator'
        end
    from totals;
$$;

revoke all on function reporting.rated_match_rate(timestamptz) from public, anon, authenticated;

-- Mismo patrón que catalog_match_count: el rol del reporter solo recibe
-- USAGE sobre el esquema y EXECUTE sobre el agregado. El rol se crea fuera
-- del repo, así que el grant solo se aplica donde ya existe (en local no).
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'watchparty_reporter') then
        grant usage on schema reporting to watchparty_reporter;
        grant execute on function reporting.rated_match_rate(timestamptz) to watchparty_reporter;
    end if;
end
$$;
