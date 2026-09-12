-- Mismo candado de acceso que ya tienen teams/matches/provider_sync_state
-- (ver 20260904222112_sports_data_schema.sql). RLS por sí solo (habilitado
-- en WAT-123) ya deniega toda fila a anon/authenticated sin políticas, pero
-- acá además se revoca el permiso de intentar la operación a nivel de
-- tabla, para que el rechazo sea un "permission denied" (42501) explícito
-- y no dependa únicamente de RLS — mismo criterio documentado en
-- rls-checks.ts para teams/matches.
--
-- El único acceso privilegiado queda para service_role: es el rol que usa
-- el backend (Node) a través del cliente servidor de WAT-106. La web nunca
-- recibe esta clave ni consulta la Data API directamente sobre profiles.
revoke all privileges on table public.profiles from anon, authenticated;

grant all privileges on table public.profiles to service_role;