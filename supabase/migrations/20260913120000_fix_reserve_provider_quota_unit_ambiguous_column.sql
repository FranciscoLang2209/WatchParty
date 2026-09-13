-- reserve_provider_quota_unit (20260912120000) declara `returns table(reserved
-- boolean, reserved_count integer)`, lo que crea automáticamente una variable
-- PL/pgSQL llamada reserved_count. En `set reserved_count = reserved_count + 1`
-- el lado derecho queda ambiguo entre esa variable y la columna de
-- provider_quota_ledger (error 42702: "column reference is ambiguous").
-- Nunca se había detectado porque los tests unitarios usan un cliente
-- Supabase falso y ningún script de verificación ejecuta esta función
-- contra una base real — lo encontró la validación real de WAT-108.
create or replace function reserve_provider_quota_unit(
  p_provider text,
  p_quota_date date,
  p_daily_limit integer
) returns table(reserved boolean, reserved_count integer)
language plpgsql
as $$
declare
v_new_count integer;
begin
  if p_provider is null or btrim(p_provider) = '' then
    raise exception 'p_provider no puede estar vacío';
end if;

  if p_daily_limit is null or p_daily_limit <= 0 then
    raise exception 'p_daily_limit debe ser mayor a cero';
end if;

insert into provider_quota_ledger (provider, quota_date, reserved_count)
values (p_provider, p_quota_date, 0)
    on conflict (provider, quota_date) do nothing;

update provider_quota_ledger
set reserved_count = provider_quota_ledger.reserved_count + 1,
    updated_at = now()
where provider = p_provider
  and quota_date = p_quota_date
  and provider_quota_ledger.reserved_count < p_daily_limit
    returning provider_quota_ledger.reserved_count into v_new_count;

if v_new_count is not null then
    return query select true, v_new_count;
return;
end if;

select provider_quota_ledger.reserved_count into v_new_count
from provider_quota_ledger
where provider = p_provider and quota_date = p_quota_date;

return query select false, v_new_count;
end;
$$;

revoke execute on function public.reserve_provider_quota_unit(text, date, integer)
    from public, anon, authenticated;
grant execute on function public.reserve_provider_quota_unit(text, date, integer)
  to service_role;