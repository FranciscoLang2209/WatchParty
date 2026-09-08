# Runbook: esquema de datos deportivos (local)

Este runbook documenta cómo levantar, resetear y verificar el esquema de datos deportivos (`teams`, `matches`, `provider_sync_state`) en el entorno local de Supabase. Todo lo que describe acá corre exclusivamente contra los contenedores Docker de tu máquina — no toca ningún proyecto remoto ni de producción.

## Qué hace `supabase db reset --local`

```
pnpm exec supabase db reset --local
```

Este comando resetea el esquema de la base de datos local y reaplica migraciones y seed, dentro del mismo contenedor de Postgres que ya está corriendo. En orden:

1. Resetea el esquema de la base de datos local (no recrea el contenedor de Postgres: reutiliza el que ya está levantado con `pnpm supabase:start`).
2. Aplica, en orden cronológico por su nombre de archivo, todas las migraciones de `supabase/migrations/`:
   - `..._sports_data_schema.sql`: crea `teams`, `matches` y `provider_sync_state`, con sus constraints, índices, triggers de `updated_at`, y RLS habilitado (sin políticas) en las tres; además revoca los privilegios de tabla de `anon`/`authenticated` y los otorga a `service_role`.
   - `..._provider_sync_lease_functions.sql`: crea las 4 funciones de coordinación del lease de sincronización y restringe su `EXECUTE` a `service_role`.
3. Carga `supabase/seed.sql`: datos de ejemplo ficticios (4 equipos, 3 partidos en distintos estados, 1 registro de `provider_sync_state` sin lease tomado).

Este comando no reinicia necesariamente los contenedores de los demás servicios (Auth, API REST, Studio); si después de resetear notás algo inconsistente en esos servicios, corré `pnpm supabase:stop` seguido de `pnpm supabase:start`.

El flag `--local` es lo que garantiza que todo esto ocurre solo en tu Docker local. No hay forma de que este comando afecte un proyecto de Supabase remoto, ni siquiera necesita haber uno configurado para funcionar. Podés correrlo las veces que quieras: es la forma esperada de "empezar de cero" durante el desarrollo.

## Requisitos previos

- Docker corriendo, y el stack de Supabase levantado (`pnpm supabase:start`).
- Un archivo `apps/api/.env` con:
  ```
  SUPABASE_URL=http://127.0.0.1:54321
  SUPABASE_ANON_KEY=<Publishable key de "pnpm exec supabase status">
  SUPABASE_SERVICE_ROLE_KEY=<Secret key de "pnpm exec supabase status">
  ```
  `SUPABASE_ANON_KEY` es una clave publicable por diseño (es la misma que usa el frontend). `SUPABASE_SERVICE_ROLE_KEY` **no**: es una credencial con privilegios administrativos que salta RLS y todos los permisos de tabla, incluso en local. Que cualquier instalación local de Supabase genere el mismo valor fijo por defecto no la vuelve pública ni segura de compartir — nunca se comitea, no se pega en chats ni tickets, y este archivo permanece en `.gitignore`.

## Verificar constraints, RLS y el ciclo de vida del lease

Toda la verificación está automatizada en un único script:

```
pnpm exec supabase db reset --local
pnpm --filter @watchparty/api verify:sports-data
```

El script (`apps/api/scripts/verify-sports-data-schema.ts`) se conecta a la base local con tres clientes distintos — `service_role` (privilegios de administrador, el mismo acceso que va a usar el backend real), `anon` (sin sesión) y un usuario autenticado descartable — y corre todos los chequeos de los tres grupos siguientes (la cantidad exacta puede crecer con el tiempo; lo importante es que el script termine con "Todos los chequeos pasaron.").

### 1. Constraints (`checks/constraints-checks.ts`)

Confirma que es la base de datos, no la aplicación, la que rechaza datos inválidos, sin modificar los datos válidos ya sembrados:

- Un partido con `home_team_id = away_team_id` debe fallar por el CHECK `matches_distinct_teams`.
- Un equipo con un `(provider, external_id)` ya existente debe fallar por el UNIQUE `teams_provider_external_id_key`.
- Un partido con un `(provider, external_id)` ya existente debe fallar por el UNIQUE `matches_provider_external_id_key`.
- Un `provider_sync_state` con un `(provider, competition_external_id, season)` ya existente debe fallar por el UNIQUE `provider_sync_state_scope_key`.
- Un partido con `home_team_id` o `away_team_id` inexistente debe fallar por la FK correspondiente.
- Un partido con `status` fuera de `scheduled`/`live`/`finished`/`postponed`/`cancelled` debe fallar por el CHECK de `status`.

Todos los inserts de prueba usan datos válidos salvo por el campo bajo prueba, para que el error observado corresponda al constraint esperado y no a un FK, CHECK o UNIQUE distinto.

### 2. Permisos y Row Level Security (`checks/rls-checks.ts`)

Confirma que ni `anon` ni `authenticated` pueden **leer, insertar, actualizar ni borrar** filas de `teams`, `matches` o `provider_sync_state`, y que cada intento devuelve específicamente el código `42501` ("permission denied") — no una lista vacía ni un error distinto. Esto demuestra que el rechazo ocurre por los `REVOKE` explícitos de la migración, además de por RLS. También confirma que `service_role` sí puede leer las tres tablas: es el único acceso privilegiado, y en este proyecto solo debería usarlo el backend (Node), nunca el frontend.

### 3. Ciclo de vida del lease (`checks/lease-checks.ts`)

Ejercita las 4 funciones de coordinación sobre el registro sembrado en `seed.sql`:

- `acquire_provider_sync_lease` adquiere un lease libre, no permite que un segundo "worker" se robe uno ya tomado, y rechaza un `p_owner` vacío o un `p_lease_duration` no positivo.
- `release_provider_sync_lease` rechaza un token que no coincide, y libera correctamente con el token correcto.
- `reclaim_expired_provider_sync_lease` recupera un lease cuyo `lease_expires_at` ya venció (simulado forzando la fecha directo por UPDATE, sin esperar tiempo real).
- `record_provider_sync_result` cierra un intento de sincronización, actualiza `last_success_at` y libera el lease — y también rechaza un token que no coincide.
- Un lease vencido no puede cerrar una sincronización ni ser liberado: se fuerza el vencimiento de un lease tomado, se confirma que `record_provider_sync_result` con el token original devuelve `false`, se recupera el lease con `reclaim_expired_provider_sync_lease`, se adquiere un token nuevo, y se confirma que el token anterior sigue sin poder liberar ni finalizar ese lease nuevo.

### Evidencia de una corrida exitosa (extracto)

```
[OK] CHECK matches_distinct_teams rechaza home_team_id = away_team_id — Postgres devolvió: new row for relation "matches" violates check constraint "matches_distinct_teams"
[OK] UNIQUE teams_provider_external_id_key rechaza (provider, external_id) duplicado — Postgres devolvió: duplicate key value violates unique constraint "teams_provider_external_id_key"
[OK] UNIQUE matches_provider_external_id_key rechaza (provider, external_id) duplicado — Postgres devolvió: duplicate key value violates unique constraint "matches_provider_external_id_key"
[OK] UNIQUE provider_sync_state_scope_key rechaza (provider, competition_external_id, season) duplicado — Postgres devolvió: duplicate key value violates unique constraint "provider_sync_state_scope_key"
[OK] FK rechaza home_team_id inexistente — Postgres devolvió: insert or update on table "matches" violates foreign key constraint
[OK] FK rechaza away_team_id inexistente — Postgres devolvió: insert or update on table "matches" violates foreign key constraint
[OK] CHECK status rechaza un valor fuera de scheduled/live/finished/postponed/cancelled — Postgres devolvió: new row for relation "matches" violates check constraint
[OK] RLS: anon no puede leer "teams" — Postgres devolvió: permission denied for table teams (code=42501)
[OK] RLS: un usuario autenticado no puede leer "teams" — Postgres devolvió: permission denied for table teams (code=42501)
[OK] RLS: anon no puede insertar en "teams" — Postgres devolvió: permission denied for table teams (code=42501)
[OK] RLS: anon no puede actualizar "teams" — Postgres devolvió: permission denied for table teams (code=42501)
[OK] RLS: anon no puede borrar en "teams" — Postgres devolvió: permission denied for table teams (code=42501)
[OK] RLS: service_role sí puede leer "teams" — Filas devueltas: 1
[OK] acquire: adquiere un lease libre
[OK] acquire: no permite adquirir un lease ya tomado
[OK] acquire: rechaza un p_owner vacío
[OK] acquire: rechaza un p_lease_duration no positivo
[OK] release: rechaza un token que no coincide con el dueño actual
[OK] release: libera el lease con el token correcto
[OK] acquire: vuelve a adquirir un lease ya liberado
[OK] reclaim: recupera un lease vencido
[OK] reclaim: deja el lease sin dueño después de recuperarlo — lease_owner=null, lease_token=null
[OK] record_provider_sync_result: rechaza un token que no coincide
[OK] record_provider_sync_result: registra éxito y libera el lease
[OK] record_provider_sync_result: deja last_success_at actualizado y el lease libre — last_success_at=2026-09-05T03:04:57.543645+00:00, lease_token=null
[OK] record_provider_sync_result: no cierra la sincronización con un lease ya vencido
[OK] reclaim: recupera el lease vencido dejado por el worker colgado
[OK] acquire: adquiere un token nuevo tras recuperar el lease vencido
[OK] release: el token vencido no puede liberar el lease nuevo
[OK] record_provider_sync_result: el token vencido no puede finalizar el lease nuevo
[OK] el lease nuevo sigue en pie después de los intentos con el token vencido — lease_owner=verify-script-F, lease_token=...
Todos los chequeos pasaron.
```

(El extracto omite las filas repetidas de `matches` y `provider_sync_state` en la sección de RLS, que siguen exactamente el mismo patrón que `teams`.)

## Troubleshooting

- **"An invalid response was received from the upstream server" al crear el usuario de prueba**: puede pasar si el script corre justo mientras los contenedores todavía están terminando de reiniciarse después de un `db reset --local`. Esperá unos segundos y volvé a correr `pnpm --filter @watchparty/api verify:sports-data` (sin resetear de nuevo).
- **Algún chequeo de RLS falla devolviendo filas en vez de un error `42501`**: revisá que la migración `..._sports_data_schema.sql` tenga las tres líneas `alter table <tabla> enable row level security;` (una por tabla), sin errores de tipeo en el nombre de la tabla.
- **Algún chequeo de RLS falla con un error distinto a `42501` (por ejemplo, la política de RLS en vez de permission denied)**: revisá que la migración `..._sports_data_schema.sql` incluya, al final, los `revoke all privileges ... from anon, authenticated` y los `grant all privileges ... to service_role` para las tres tablas — sin esos GRANT/REVOKE explícitos, RLS sin políticas igual bloquea la lectura, pero no bloquea a nivel de permisos de tabla como pide el ticket.

## Nota sobre los datos

Todos los datos de `supabase/seed.sql` son ficticios (equipos y partidos inventados bajo `provider = 'local-fixtures'`) y existen únicamente para desarrollo local. `db reset --local` los destruye y recrea cada vez que se corre — no hay ningún dato real ni de producción involucrado en este flujo.
