# Runbook: perfiles de usuario (local)

Este runbook documenta cómo levantar, resetear y verificar la tabla `profiles` en el entorno local de Supabase. Todo lo que describe corre exclusivamente contra los contenedores Docker de tu máquina — no toca ningún proyecto remoto ni de producción. Complementa a `docs/runbooks/sports-data-local.md`: los requisitos previos (Docker, `.env`) son los mismos, no se repiten acá en detalle.

## Qué agrega `supabase db reset --local` para `profiles`

Además de lo que ya aplica para `teams`/`matches`/`provider_sync_state`, el reset aplica en orden estas tres migraciones nuevas:

1. `..._profiles_table.sql` (WAT-123): crea `profiles` — `user_id` como PK y FK a `auth.users(id)` con `on delete cascade`, `display_name`, `bio` (default `''`), `favorite_team_id` (uuid, nullable), timestamps, y RLS habilitado (sin políticas). Un perfil no se crea al registrarse: solo existe cuando algo lo inserta explícitamente.
2. `..._profiles_constraints.sql` (WAT-124): agrega los límites — `display_name` entre 1 y 50 caracteres tras `btrim`, `bio` hasta 280 caracteres, y la FK de `favorite_team_id` contra `teams(id)`.
3. `..._profiles_rls_privileges.sql` (WAT-125): revoca los privilegios de tabla de `anon`/`authenticated` y los otorga a `service_role` — mismo candado que ya tienen `teams`/`matches`/`provider_sync_state`.

`supabase/seed.sql` no siembra ningún perfil: no hay usuarios de `auth.users` en el seed, así que no hay ningún `user_id` válido para referenciar de antemano. Los chequeos automatizados crean sus propios usuarios descartables antes de sembrar cualquier perfil de prueba.

## Verificar constraints y RLS

```
pnpm exec supabase db reset --local
pnpm --filter @watchparty/api verify:profiles
```

El script (`apps/api/scripts/verify-profiles-schema.ts`) se conecta con tres clientes — `service_role`, `anon` y un usuario autenticado descartable — y corre dos grupos de chequeos.

### 1. Constraints (`checks/profile-constraints-checks.ts`)

Confirma que es la base de datos, no la aplicación, la que rechaza un perfil inválido: `display_name` vacío tras `btrim` o de más de 50 caracteres, `bio` de más de 280 caracteres, y `favorite_team_id` apuntando a un equipo inexistente. También confirma que un perfil válido con `favorite_team_id: null` se acepta. Cada caso usa un usuario descartable nuevo (vía `createTempUserId`, Admin API de Supabase), porque `user_id` es la propia PK de la tabla.

### 2. Permisos y RLS (`checks/profile-rls-checks.ts`)

Confirma que ni `anon` ni un usuario autenticado real pueden leer, insertar, actualizar ni borrar filas de `profiles` de forma directa contra PostgREST, y que el código de error es específicamente `42501` (permission denied) — igual que para `teams`/`matches`. El perfil contra el que se prueba pertenece a un usuario distinto del que está logueado en el test, así que el mismo chequeo demuestra que tampoco puede tocar el perfil de otro.

**Alcance de este chequeo:** demuestra que ningún camino directo a la Data API llega a escribir sobre `profiles` — la única puerta es `service_role`. No prueba el comportamiento del endpoint HTTP real (`PUT /me/profile`), porque ese módulo (WAT-126) todavía no existe; cuando se implemente, va a tener que aplicar su propia regla de "solo el dueño edita su perfil" al hacer el `UPDATE` con `service_role`, ya que a nivel de base de datos ese rol no tiene restricciones por fila.

### Evidencia de una corrida exitosa

```
[OK] CHECK profiles_display_name_length rechaza display_name vacío tras trim — Postgres devolvió: new row for relation "profiles" violates check constraint "profiles_display_name_length"
[OK] CHECK profiles_display_name_length rechaza display_name de más de 50 caracteres — Postgres devolvió: new row for relation "profiles" violates check constraint "profiles_display_name_length"
[OK] CHECK profiles_bio_length rechaza bio de más de 280 caracteres — Postgres devolvió: new row for relation "profiles" violates check constraint "profiles_bio_length"
[OK] FK profiles_favorite_team_id_fkey rechaza favorite_team_id inexistente — Postgres devolvió: insert or update on table "profiles" violates foreign key constraint "profiles_favorite_team_id_fkey"
[OK] Un perfil válido con favorite_team_id null se acepta — Insertado sin error.
[OK] RLS: anon no puede leer "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: anon no puede insertar en "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: anon no puede actualizar el perfil de otro usuario en "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: anon no puede borrar el perfil de otro usuario en "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: un usuario autenticado (de otro perfil) no puede leer "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: un usuario autenticado (de otro perfil) no puede insertar en "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: un usuario autenticado (de otro perfil) no puede actualizar el perfil de otro usuario en "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: un usuario autenticado (de otro perfil) no puede borrar el perfil de otro usuario en "profiles" — Postgres devolvió: permission denied for table profiles (code=42501)
[OK] RLS: service_role sí puede leer "profiles" — Filas devueltas: 1

Todos los chequeos pasaron.
```

## Troubleshooting

- **"Could not find the table 'public.profiles' in the schema cache"**: las migraciones nuevas no se aplicaron todavía. Corré `pnpm exec supabase db reset --local` antes de `verify:profiles`.
- **"No se pudo crear un usuario temporal: fetch failed"**: Supabase local no está levantado o Docker no está corriendo. Confirmá con `pnpm exec supabase status` y, si hace falta, `pnpm supabase:start`.
- **Algún chequeo de RLS falla devolviendo filas en vez de `42501`**: revisá que `..._profiles_rls_privileges.sql` tenga el `revoke`/`grant` sobre `public.profiles`, y que `..._profiles_table.sql` tenga el `alter table profiles enable row level security;`.

## Nota sobre los datos

Todos los usuarios y perfiles que crean estos chequeos son descartables: se generan con `createTempUserId`/`getTempUserAccessToken` en cada corrida y desaparecen en el próximo `db reset --local`. No hay ningún dato real ni de producción involucrado en este flujo.
