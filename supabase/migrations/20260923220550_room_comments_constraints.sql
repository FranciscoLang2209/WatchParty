-- Completa el contrato de room_comments (WAT-147 solo creó la tabla, sin
-- límites). El límite es el mismo que ya hace cumplir la API (WAT-150, ver
-- BODY_MIN_LENGTH/BODY_MAX_LENGTH en
-- apps/api/src/modules/comments/domain/room-comment-store.ts): no se
-- inventa acá, se hace cumplir acá. Mismo criterio que
-- profiles_display_name_length en 20260912160809_profiles_constraints.sql.
--
-- Sin este check, cualquier escritura que no pase por la API HTTP (un
-- script de mantenimiento, una consola con service_role) podía insertar un
-- comentario vacío, de solo espacios, o más largo que lo que la UI permite
-- mostrar.
alter table room_comments
    add constraint room_comments_body_length
        check (char_length(btrim(body)) between 1 and 180);
