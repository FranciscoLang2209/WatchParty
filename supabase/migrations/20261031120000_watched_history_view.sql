-- Historial de vistos con la nota propia de cada partido (WAT-263). Es
-- aditiva: crea una vista nueva y no modifica tablas ni datos.
--
-- Por qué una vista: `match_ratings` no tiene FK hacia `watched_matches`, así
-- que PostgREST no puede cruzarlas en una consulta. Sin la vista, filtrar el
-- historial por "con nota"/"sin nota" obligaba a mandar la lista de partidos
-- calificados en la URL (`match_id=in.(...)`), que con ~200 notas supera el
-- largo máximo de la URI y con más de `max_rows` se trunca en silencio. Con
-- la vista el cruce lo resuelve la base y el filtro es `rating is [not] null`
-- en la misma consulta que pagina.
--
-- El join es por (user_id, match_id): `rating` es solo la nota del mismo
-- usuario que marcó el visto, nunca la de otro. La PK de match_ratings
-- garantiza a lo sumo una nota por visto, así que la vista no duplica filas.
-- `match_id` sale de watched_matches, así que PostgREST sigue embebiendo el
-- partido por `watched_matches_match_id_fkey`.
--
-- security_invoker: la vista corre con los permisos de quien la consulta, no
-- de su dueño, así que no abre un atajo alrededor de RLS de las tablas.
create view public.watched_history
    with (security_invoker = true)
as
select w.user_id, w.match_id, w.created_at, r.rating
from public.watched_matches w
         left join public.match_ratings r
                   on r.user_id = w.user_id and r.match_id = w.match_id;

-- Mismo candado que watched_matches y match_ratings: solo el backend (Node)
-- con service_role, y solo lectura. Se revoca también a service_role porque
-- los privilegios por defecto de Supabase le dan todo, y una vista simple
-- como esta es actualizable: escribiría en watched_matches a través de ella.
revoke all privileges on table public.watched_history from anon, authenticated, service_role;

grant select on table public.watched_history to service_role;
