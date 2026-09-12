-- Perfil de usuario. Un perfil no se crea al registrarse: existe solo cuando
-- saveOwnProfile (WAT-126) lo guarda por primera vez. user_id es a la vez PK
-- y FK a auth.users, así que por diseño no puede existir más de un perfil
-- por usuario (ON DELETE CASCADE: si se borra el usuario, se borra su perfil).
create table profiles (
                          user_id uuid primary key references auth.users(id) on delete cascade,
                          display_name text not null,
                          bio text not null default '',
    -- Mismo tipo que teams.id (uuid). Sin FK todavía: la agrega WAT-124 junto
    -- con los checks de longitud, para mantener cada migración chica y acotada
    -- a lo que factura su propio ticket. Nullable: null = sin equipo favorito.
                          favorite_team_id uuid,
                          created_at timestamptz not null default now(),
                          updated_at timestamptz not null default now()
);

-- Sin políticas todavía (quedan para WAT-125, junto con el revoke/grant de
-- privilegios de tabla). RLS habilitado y sin políticas ya deniega toda
-- lectura/escritura a anon/authenticated -- ver rls-checks.ts para el mismo
-- razonamiento aplicado a teams/matches.
alter table profiles enable row level security;

-- Reusa la función creada en 20260904222112_sports_data_schema.sql: no hace
-- falta redefinirla.
create trigger profiles_set_updated_at
    before update on profiles
    for each row
    execute function public.set_updated_at();