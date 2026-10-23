-- Resumen público de calificaciones de un partido (WAT-214): cantidad de
-- votos y promedio, calculados por la base sobre `match_ratings` (WAT-211).
-- Es aditiva: crea una función nueva y no modifica tablas ni datos.
--
-- Por qué una función y no un SELECT desde Node:
--   * El promedio y la cuenta se calculan donde están los datos: el backend
--     nunca trae las notas de otros usuarios, solo dos números.
--   * Un usuario = una fila (PK user_id, match_id), así que editar una nota
--     cambia el valor sin sumar otro votante: la cuenta sale de count(*).
--
-- Contrato de la fila que devuelve (siempre exactamente una, porque un
-- agregado sin GROUP BY siempre produce una fila):
--   * rating_count: 0 o más.
--   * rating_average: NULL si no hay votos. Las notas van de 1 a 5, así que
--     un promedio real nunca es 0: NULL significa "sin votos" y no se
--     confunde con un promedio cero. Con votos, va redondeado a 2 decimales.
--
-- SECURITY INVOKER (por defecto): corre con los permisos de quien la llama,
-- y solo service_role puede ejecutarla ni leer la tabla. `search_path`
-- vacío para que nada se resuelva por un esquema ajeno.
create or replace function public.match_rating_summary(p_match_id uuid)
    returns table (rating_count bigint, rating_average numeric)
    language sql
    stable
    set search_path = ''
as $$
select count(*), round(avg(r.rating), 2)
from public.match_ratings r
where r.match_id = p_match_id;
$$;

-- Uso exclusivo del backend, igual que la tabla y el resto de las funciones.
revoke execute on function public.match_rating_summary(uuid) from public, anon, authenticated;

grant execute on function public.match_rating_summary(uuid) to service_role;
