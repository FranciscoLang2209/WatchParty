-- WAT-184: persistir el resumen del último intento de sincronización.
--
-- Hasta ahora provider_sync_state guardaba fechas y error del último
-- intento, pero las cantidades del resumen solo se imprimían. Extendemos la
-- misma fila (sin tabla de historial): los contadores describen SIEMPRE el
-- último intento cerrado con record_provider_sync_result.
--
-- NULL significa "ese intento no informó resumen" (o nunca hubo un intento
-- cerrado); 0 significa "se informó y fue cero". Los contadores de omitidos
-- y errores son totales (suma de todos los motivos); no se guardan los
-- motivos ni respuestas del proveedor.

alter table public.provider_sync_state
    add column last_attempt_imported_count integer,
  add column last_attempt_updated_count integer,
  add column last_attempt_skipped_count integer,
  add column last_attempt_error_count integer,
  add column last_attempt_queries_count integer;

alter table public.provider_sync_state
    add constraint provider_sync_state_attempt_counts_not_negative check (
        (last_attempt_imported_count is null or last_attempt_imported_count >= 0)
            and (last_attempt_updated_count is null or last_attempt_updated_count >= 0)
            and (last_attempt_skipped_count is null or last_attempt_skipped_count >= 0)
            and (last_attempt_error_count is null or last_attempt_error_count >= 0)
            and (last_attempt_queries_count is null or last_attempt_queries_count >= 0)
        );

-- Agregar parámetros crea un overload nuevo en vez de reemplazar la
-- función: se elimina la firma anterior para que PostgREST no tenga dos
-- candidatas ambiguas al resolver los argumentos por nombre. Los grants se
-- vuelven a declarar abajo porque pertenecen a la firma nueva.
drop function if exists public.record_provider_sync_result(
    text, text, text, uuid, boolean, text, integer, timestamptz
    );

-- Igual que antes: exige el token del lease vigente, actualiza
-- last_attempt_at / last_success_at, deja last_error solo si falló y libera
-- el lease. Además guarda el resumen del intento. Los contadores se
-- reemplazan siempre (sin coalesce) para que nunca queden cantidades de un
-- intento anterior junto a las fechas del actual.
create or replace function public.record_provider_sync_result(
  p_provider text,
  p_competition_external_id text,
  p_season text,
  p_lease_token uuid,
  p_success boolean,
  p_error text default null,
  p_observed_quota_remaining integer default null,
  p_observed_quota_window_reset_at timestamptz default null,
  p_imported_count integer default null,
  p_updated_count integer default null,
  p_skipped_count integer default null,
  p_error_count integer default null,
  p_queries_count integer default null
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
    last_attempt_imported_count = p_imported_count,
    last_attempt_updated_count = p_updated_count,
    last_attempt_skipped_count = p_skipped_count,
    last_attempt_error_count = p_error_count,
    last_attempt_queries_count = p_queries_count,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where provider = p_provider
  and competition_external_id = p_competition_external_id
  and season = p_season
  and lease_token = p_lease_token
  and lease_expires_at > now();

return found;
end;
$$;

-- Uso exclusivo del backend (service_role), igual que el resto de las
-- funciones de lease. La tabla conserva RLS y sin privilegios para
-- anon/authenticated: las columnas nuevas no se exponen a roles web.
revoke execute on function public.record_provider_sync_result(
    text, text, text, uuid, boolean, text, integer, timestamptz,
    integer, integer, integer, integer, integer
    ) from public, anon, authenticated;

grant execute on function public.record_provider_sync_result(
  text, text, text, uuid, boolean, text, integer, timestamptz,
  integer, integer, integer, integer, integer
) to service_role;