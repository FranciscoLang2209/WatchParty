-- Reseña de un partido por un usuario (WAT-252). Una única reseña por par
-- (usuario, partido), separada de match_ratings (WAT-211): la nota y el
-- texto evolucionan por separado y las métricas, promedios y KPIs que leen
-- match_ratings no cambian. Sin store, rutas HTTP ni UI todavía (quedan
-- fuera de este ticket): esta migración solo garantiza la relación, el
-- largo del texto y el candado de permisos en la base. Es aditiva: crea una
-- tabla nueva y no modifica ninguna existente, así que no toca datos previos.
--
-- Sin ON DELETE CASCADE en ninguna FK: borrar un usuario o un partido con
-- reseñas asociadas queda bloqueado (NO ACTION), no deja una fila huérfana
-- ni borra el texto en silencio. Mismo criterio que match_ratings.
create table match_reviews (
    user_id uuid not null references auth.users(id),
    match_id uuid not null references matches(id),
    -- Texto plano. El límite de 500 se aplica al texto tal como se guarda
    -- (con sus blancos); el "no vacío" se mide aparte, sin espacios,
    -- tabulaciones ni saltos de línea en los extremos (btrim solo recorta
    -- espacios por defecto). Así ni un texto de solo blancos ni uno largo
    -- rellenado con espacios pasan.
    body text not null,
    -- created_at = cuándo reseñó por primera vez; updated_at = cuándo editó
    -- el texto por última vez (lo mantiene el trigger de abajo).
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- La PK hace cumplir "una reseña por par": reintentos y pedidos
    -- concurrentes chocan contra ella en vez de depender de un "leer y
    -- después insertar" con condición de carrera.
    primary key (user_id, match_id),
    constraint match_reviews_body_max_length check (char_length(body) <= 500),
    constraint match_reviews_body_not_blank check (char_length(btrim(body, E' \t\r\n')) >= 1)
);

-- La PK ya cubre consultas por user_id (columna líder). Sin este índice,
-- buscar por match_id solo -- reseñas de un partido, o la FK al borrar un
-- partido -- hace un seq scan; mismo motivo que match_ratings_match_id_idx.
create index match_reviews_match_id_idx on match_reviews (match_id);

-- Reutiliza public.set_updated_at() (20260904222112_sports_data_schema.sql).
create trigger match_reviews_set_updated_at
    before update on match_reviews
    for each row
    execute function public.set_updated_at();

alter table match_reviews enable row level security;

-- Sin políticas: la web nunca consulta esta tabla directamente, solo el
-- backend (Node) con service_role. Mismo candado que match_ratings: RLS
-- deniega las filas y el revoke deniega intentar la operación.
revoke all privileges on table public.match_reviews from anon, authenticated;

grant all privileges on table public.match_reviews to service_role;
