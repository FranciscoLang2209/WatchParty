-- Calificación de un partido por un usuario (WAT-211). Una única nota por
-- par (usuario, partido). Sin store, rutas HTTP ni UI todavía (quedan fuera
-- de este ticket): esta migración solo garantiza la relación, el rango y el
-- candado de permisos en la base, igual que watched_matches (WAT-166) antes
-- de tener su propia API. Es aditiva: crea una tabla nueva y no modifica
-- ninguna existente, así que no toca datos previos.
--
-- Sin ON DELETE CASCADE en ninguna FK: borrar un usuario o un partido con
-- calificaciones asociadas queda bloqueado (NO ACTION), no deja una fila
-- huérfana ni borra la nota en silencio. Mismo criterio que
-- watched_matches, rooms.match_id y room_comments.author_id.
create table match_ratings (
                               user_id uuid not null references auth.users(id),
                               match_id uuid not null references matches(id),
    -- Entero entre 1 y 5. smallint ya rechaza decimales ("3.5") y texto; el
    -- CHECK rechaza lo que sea entero pero fuera de rango. NOT NULL: una fila
    -- sin nota no significa nada; "sin calificar" es la ausencia de la fila.
                               rating smallint not null,
    -- Para las métricas mensuales: created_at = cuándo calificó por primera
    -- vez; updated_at = cuándo cambió la nota por última vez (lo mantiene el
    -- trigger de abajo, no la aplicación).
                               created_at timestamptz not null default now(),
                               updated_at timestamptz not null default now(),
    -- La PK hace cumplir "una nota por par": reintentos y pedidos
    -- concurrentes chocan contra ella en vez de depender de un "leer y
    -- después insertar" con condición de carrera.
                               primary key (user_id, match_id),
                               constraint match_ratings_rating_range check (rating between 1 and 5)
);

-- La PK ya cubre consultas por user_id (columna líder). Sin este índice,
-- buscar por match_id solo -- promedio por partido, o la FK al borrar un
-- partido -- hace un seq scan; mismo motivo que watched_matches_match_id_idx.
create index match_ratings_match_id_idx on match_ratings (match_id);

-- Reutiliza public.set_updated_at() (20260904222112_sports_data_schema.sql).
create trigger match_ratings_set_updated_at
    before update on match_ratings
    for each row
    execute function public.set_updated_at();

alter table match_ratings enable row level security;

-- Sin políticas: la web nunca consulta esta tabla directamente, solo el
-- backend (Node) con service_role. Las notas son privadas de cada usuario:
-- ni anon ni authenticated pueden leerlas, ni siquiera las propias, hasta
-- que la API (otro ticket) decida qué se expone. Mismo candado que
-- watched_matches/rooms/profiles: RLS deniega las filas y el revoke deniega
-- intentar la operación.
revoke all privileges on table public.match_ratings from anon, authenticated;

grant all privileges on table public.match_ratings to service_role;