-- Reacción "Me gusta" a un comentario de sala (WAT-165). Es el único tipo de
-- reacción del MVP, así que no hay columna `type`: agregarla es un cambio de
-- modelo que se justifica cuando exista un segundo tipo.
--
-- La regla "una persona, un Me gusta por comentario" la hace cumplir la base,
-- no la API: reintentos y pedidos concurrentes chocan contra el UNIQUE en vez
-- de depender de un "leer y después insertar" que tiene condición de carrera.

create table room_comment_reactions(
    id uuid primary key default gen_random_uuid(),
    -- Si se borra el comentario, sus reacciones se van con él (no quedan
    -- huérfanas). room_comments hoy no se borra desde la API; esto deja la
    -- base consistente si algún día pasa.
    comment_id uuid not null references room_comments(id) on delete cascade,
    -- Sin ON DELETE CASCADE, igual que room_comments.author_id y
    -- profiles.user_id: borrar un usuario de auth.users es una decisión que
    -- hoy no está tomada para ninguna tabla propia; se resuelve para todas a
    -- la vez, no solo acá.
    user_id uuid not null references auth.users(id),
    created_at timestamptz not null default now(),
    -- comment_id va primero a propósito: el índice que respalda este UNIQUE
    -- también sirve para contar reacciones por comentario (prefijo comment_id),
    -- así no hace falta un índice extra. Como restricción, (comment_id, user_id)
    -- y (user_id, comment_id) son equivalentes: solo cambia el orden del índice.
    constraint room_comment_reactions_comment_user_key unique (comment_id, user_id)
);

-- Sin políticas: la web nunca consulta esta tabla directamente, solo el
-- backend (Node) con service_role. Mismo candado que rooms/room_comments:
-- RLS deniega las filas y el revoke deniega intentar la operación.
alter table room_comment_reactions enable row level security;

revoke all privileges on table public.room_comment_reactions from anon, authenticated;

grant all privileges on table public.room_comment_reactions to service_role;