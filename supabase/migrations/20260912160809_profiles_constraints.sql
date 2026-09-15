-- Completa el contrato de profiles (WAT-123 solo creó la tabla, sin
-- límites). Los límites de display_name/bio son los mismos que ya usa el
-- frontend (WAT-130/WAT-133, ver apps/web/src/features/profiles/types.ts):
-- no se inventan acá, se hacen cumplir acá.
alter table profiles
    add constraint profiles_display_name_length
        check (char_length(btrim(display_name)) between 1 and 50),
  add constraint profiles_bio_length
    check (char_length(bio) <= 280);

-- favorite_team_id ya existía como uuid nullable (WAT-123); ahora se
-- restringe a equipos que existan de verdad. Sigue nullable: null sigue
-- significando "sin equipo favorito", y es lo que se manda para quitarlo.
alter table profiles
    add foreign key (favorite_team_id) references teams(id);