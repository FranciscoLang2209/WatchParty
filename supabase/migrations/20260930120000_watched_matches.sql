-- Partido visto por un usuario (WAT-166). Sin store, rutas HTTP ni UI
-- todavía (quedan fuera de este ticket): esta migración solo garantiza la
-- relación en la base, igual que rooms/room_comments antes de tener su
-- propia API.
--
-- Sin ON DELETE CASCADE en ninguna FK: borrar un usuario o un partido con
-- filas asociadas queda bloqueado (NO ACTION), no deja una fila huérfana.
-- Mismo criterio que rooms.match_id y room_comments.room_id/author_id;
-- distinto de profiles.user_id, que sí cascadea porque un perfil es 1:1 y
-- propiedad exclusiva del usuario.
create table watched_matches (
    user_id uuid not null references auth.users(id),
    match_id uuid not null references matches(id),
    created_at timestamptz not null default now(),
    primary key (user_id, match_id)
);

-- La PK ya cubre consultas por user_id (es la columna líder). Sin este
-- índice, buscar por match_id solo -- por ejemplo, la FK al borrar un
-- partido -- hace un seq scan; mismo motivo que
-- matches_home_team_id_idx/matches_away_team_id_idx en
-- 20260904222112_sports_data_schema.sql.
create index watched_matches_match_id_idx on watched_matches (match_id);

alter table watched_matches enable row level security;

-- Sin políticas: la web nunca consulta esta tabla directamente, solo el
-- backend (Node) con service_role. Mismo candado que teams/matches/rooms/
-- room_comments/profiles: RLS deniega las filas y el revoke deniega
-- intentar la operación.
revoke all privileges on table public.watched_matches from anon, authenticated;

grant all privileges on table public.watched_matches to service_role;