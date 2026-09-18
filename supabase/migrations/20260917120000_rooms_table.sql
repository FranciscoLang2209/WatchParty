-- Sala pública de un partido. Existe como máximo una por partido: el UNIQUE
-- sobre match_id es lo que usa getOrCreatePublicRoom (WAT-146) para resolver
-- colisiones cuando dos pedidos intentan crearla a la vez. Reutiliza los IDs
-- internos de matches (WAT-106): no duplica datos del partido.
create table rooms (
                       id uuid primary key default gen_random_uuid(),
                       match_id uuid not null references matches(id),
                       created_at timestamptz not null default now(),
                       constraint rooms_match_id_key unique (match_id)
);

-- Sin políticas: la web nunca consulta esta tabla directamente, solo el
-- backend (Node) con service_role. Mismo candado que teams/matches/profiles:
-- RLS deniega las filas y el revoke deniega intentar la operación.
alter table rooms enable row level security;

revoke all privileges on table public.rooms from anon, authenticated;

grant all privileges on table public.rooms to service_role;
