-- KPI de negocio monthly_interactions_avg (WAT-221, ADR-05 rev. 2.0).
-- Agregado de solo lectura para el reporter: devuelve un único número y
-- nunca filas personales. Es aditiva: crea una función nueva en reporting y
-- no modifica ninguna tabla.
--
-- Reutiliza la preparación de 20261022120000_reporting_rated_match_rate.sql
-- (WAT-220): postgres ya tiene USAGE y CREATE sobre reporting, el reporter ya
-- tiene USAGE, y las cuentas técnicas están en reporting.technical_accounts.

-- Promedio de interacciones por usuario activo en el mes argentino hasta el
-- corte T. Unidad {interaction}/{user}; admite decimales.
--
-- - Interacciones: notas (match_ratings) y comentarios (room_comments)
--   persistidos en el período, por created_at. Editar una nota cambia
--   updated_at, no crea un registro: no suma. Las reacciones no son
--   interacciones. Cada tabla se cuenta por separado, sin joins, así que
--   ningún registro se multiplica.
-- - Usuarios activos: usuarios distintos con un visto, una nota o un
--   comentario registrado en el período. Un usuario que solo marcó vistos es
--   activo y aporta cero interacciones.
-- - Las cuentas técnicas se excluyen de las tres fuentes.
--
-- Nunca inventa un valor: sin usuarios activos devuelve value null con
-- motivo 'no-denominator', y con un corte nulo o futuro 'invalid-cutoff'. Con
-- denominador válido, value es finito y no negativo, y el motivo es null.
--
-- SECURITY DEFINER con search_path vacío: el reporter solo puede ejecutar
-- esta función, no leer las tablas que agrega.
create function reporting.monthly_interactions_avg(cutoff timestamptz)
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
    activity as (
        select w.user_id, 0 as interactions
        from public.watched_matches w
        cross join period p
        where w.created_at >= p.starts_at and w.created_at <= p.ends_at
        union all
        select r.user_id, 1
        from public.match_ratings r
        cross join period p
        where r.created_at >= p.starts_at and r.created_at <= p.ends_at
        union all
        select c.author_id, 1
        from public.room_comments c
        cross join period p
        where c.created_at >= p.starts_at and c.created_at <= p.ends_at
    ),
    totals as (
        select
            count(distinct a.user_id) as active_users,
            coalesce(sum(a.interactions), 0) as interactions
        from activity a
        where not exists (
            select 1 from reporting.technical_accounts t where t.user_id = a.user_id
        )
    )
    select
        case
            when cutoff is null or cutoff > now() then null
            when active_users = 0 then null
            else interactions::double precision / active_users
        end,
        case
            when cutoff is null or cutoff > now() then 'invalid-cutoff'
            when active_users = 0 then 'no-denominator'
        end
    from totals;
$$;

revoke all on function reporting.monthly_interactions_avg(timestamptz) from public, anon, authenticated;

-- El reporter ya tiene USAGE sobre reporting (WAT-220); acá solo recibe
-- EXECUTE, que otorga postgres como dueño de la función. El rol se crea
-- fuera del repo, así que el grant solo se aplica donde ya existe (en local no).
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'watchparty_reporter') then
        grant execute on function reporting.monthly_interactions_avg(timestamptz) to watchparty_reporter;
    end if;
end
$$;
