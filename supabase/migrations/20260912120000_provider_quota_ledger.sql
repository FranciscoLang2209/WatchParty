-- Ledger de cuota diaria (UTC) reservada contra un proveedor externo.
-- Complementa a provider_sync_state: ese registra lo que el proveedor
-- INFORMÓ como restante (vía headers), este cuenta lo que NOSOTROS
-- reservamos antes de cada llamada, persistido entre ejecuciones
-- separadas del comando de sincronización en el mismo día UTC.
create table provider_quota_ledger (
                                       id uuid primary key default gen_random_uuid(),
                                       provider text not null,
                                       quota_date date not null,
                                       reserved_count integer not null default 0,
                                       created_at timestamptz not null default now(),
                                       updated_at timestamptz not null default now(),
                                       constraint provider_quota_ledger_scope_key unique (provider, quota_date),
                                       constraint provider_quota_ledger_provider_not_blank check (btrim(provider) <> ''),
                                       constraint provider_quota_ledger_reserved_count_not_negative check (reserved_count >= 0)
);

alter table provider_quota_ledger enable row level security;

create trigger provider_quota_ledger_set_updated_at
    before update on provider_quota_ledger
    for each row
    execute function public.set_updated_at();

revoke all privileges on table public.provider_quota_ledger from anon, authenticated;
grant all privileges on table public.provider_quota_ledger to service_role;

-- Reserva atómica de una unidad de cuota diaria. Crea la fila del día si no
-- existe (arrancando en 0) y solo incrementa si no se superó p_daily_limit.
-- Devuelve si se pudo reservar y el contador resultante, para que el
-- caller sepa el presupuesto restante sin una segunda consulta.
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
set reserved_count = reserved_count + 1,
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