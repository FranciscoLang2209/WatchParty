# Runbook: esquema de datos deportivos (local)

Este runbook documenta cómo levantar, resetear y verificar el esquema de datos deportivos (`teams`, `matches`, `provider_sync_state`) en el entorno local de Supabase. Todo lo que describe acá corre exclusivamente contra los contenedores Docker de tu máquina — no toca ningún proyecto remoto ni de producción.

## Qué hace `supabase db reset --local`

```
pnpm exec supabase db reset --local
```

Este comando reconstruye la base de datos local desde cero, en este orden:

1. Recrea el contenedor de Postgres y aplica el esquema base de Supabase (roles, extensiones).
2. Aplica, en orden cronológico por su nombre de archivo, todas las migraciones de `supabase/migrations/`:
   - `..._sports_data_schema.sql`: crea `teams`, `matches` y `provider_sync_state`, con sus constraints, índices, y RLS habilitado (sin políticas) en las tres.
   - `..._provider_sync_lease_functions.sql`: crea las 4 funciones de coordinación del lease de sincronización.
3. Carga `supabase/seed.sql`: datos de ejemplo ficticios (4 equipos, 3 partidos en distintos estados, 1 registro de `provider_sync_state` sin lease tomado).
4. Reinicia los contenedores de los demás servicios (Auth, API REST, Studio) para que reflejen el estado nuevo.

El flag `--local` es lo que garantiza que todo esto ocurre solo en tu Docker local. No hay forma de que este comando afecte un proyecto de Supabase remoto, ni siquiera necesita haber uno configurado para funcionar. Podés correrlo las veces que quieras: es la forma esperada de "empezar de cero" durante el desarrollo.

## Requisitos previos

- Docker corriendo, y el stack de Supabase levantado (`pnpm supabase:start`).
- Un archivo `apps/api/.env` con:
  ```
  SUPABASE_URL=http://127.0.0.1:54321
  SUPABASE_ANON_KEY=<Publishable key de "pnpm exec supabase status">
  SUPABASE_SERVICE_ROLE_KEY=<Secret key de "pnpm exec supabase status">
  ```
  Ninguna de estas dos keys es un secreto real: son valores fijos que cualquier instalación local de Supabase genera igual. Aun así, este archivo nunca se commitea (está en `.gitignore`).

## Verificar constraints, RLS y el ciclo de vida del lease

Toda la verificación está automatizada en un único script:

```
pnpm exec supabase db reset --local
pnpm --filter @watchparty/api verify:sports-data
```

El script (`apps/api/scripts/verify-sports-data-schema.ts`) se conecta a la base local con tres clientes distintos — `service_role` (privilegios de administrador, el mismo acceso que va a usar el backend real), `anon` (sin sesión) y un usuario autenticado descartable — y corre 18 chequeos en tres grupos.

### 1. Constraints (`checks/constraints-checks.ts`)

Confirma que es la base de datos, no la aplicación, la que rechaza datos inválidos:

- Insertar un partido con `home_team_id = away_team_id` debe fallar por el CHECK `matches_distinct_teams`.
- Insertar un equipo con un `(provider, external_id)` ya existente debe fallar por el UNIQUE `teams_provider_external_id_key`.

### 2. Row Level Security (`checks/rls-checks.ts`)

Confirma que ni un visitante anónimo ni un usuario autenticado común pueden leer ni escribir `teams`, `matches` o `provider_sync_state`. El único acceso privilegiado es vía `service_role`, que en este proyecto solo debería usar el backend (Node), nunca el frontend.

### 3. Ciclo de vida del lease (`checks/lease-checks.ts`)

Ejercita las 4 funciones de coordinación sobre el registro sembrado en `seed.sql`:

- `acquire_provider_sync_lease` adquiere un lease libre, y no permite que un segundo "worker" se robe uno ya tomado.
- `release_provider_sync_lease` rechaza un token que no coincide, y libera correctamente con el token correcto.
- `reclaim_expired_provider_sync_lease` recupera un lease cuyo `lease_expires_at` ya venció (simulado forzando la fecha directo por UPDATE, sin esperar tiempo real).
- `record_provider_sync_result` cierra un intento de sincronización, actualiza `last_success_at` y libera el lease — y también rechaza un token que no coincide.

### Evidencia de una corrida exitosa

```
[OK] CHECK matches_distinct_teams rechaza home_team_id = away_team_id — Postgres devolvió: new row for relation "matches" violates check constraint "matches_distinct_teams"
[OK] UNIQUE teams_provider_external_id_key rechaza (provider, external_id) duplicado — Postgres devolvió: duplicate key value violates unique constraint "teams_provider_external_id_key"
[OK] RLS: anon no puede leer "teams" — Filas devueltas: 0
[OK] RLS: un usuario autenticado no puede leer "teams" — Filas devueltas: 0
[OK] RLS: anon no puede leer "matches" — Filas devueltas: 0
[OK] RLS: un usuario autenticado no puede leer "matches" — Filas devueltas: 0
[OK] RLS: anon no puede leer "provider_sync_state" — Filas devueltas: 0
[OK] RLS: un usuario autenticado no puede leer "provider_sync_state" — Filas devueltas: 0
[OK] RLS: anon no puede insertar en "teams" — Postgres devolvió: new row violates row-level security policy for table "teams"
[OK] acquire: adquiere un lease libre
[OK] acquire: no permite adquirir un lease ya tomado
[OK] release: rechaza un token que no coincide con el dueño actual
[OK] release: libera el lease con el token correcto
[OK] acquire: vuelve a adquirir un lease ya liberado
[OK] reclaim: recupera un lease vencido
[OK] reclaim: deja el lease sin dueño después de recuperarlo — lease_owner=null, lease_token=null
[OK] record_provider_sync_result: rechaza un token que no coincide
[OK] record_provider_sync_result: registra éxito y libera el lease
[OK] record_provider_sync_result: deja last_success_at actualizado y el lease libre — last_success_at=2026-09-05T03:04:57.543645+00:00, lease_token=null
Todos los chequeos pasaron.
```

## Troubleshooting

- **"An invalid response was received from the upstream server" al crear el usuario de prueba**: puede pasar si el script corre justo mientras los contenedores todavía están terminando de reiniciarse después de un `db reset --local`. Esperá unos segundos y volvé a correr `pnpm --filter @watchparty/api verify:sports-data` (sin resetear de nuevo).
- **Algún chequeo de RLS falla devolviendo filas en vez de cero**: revisá que la migración `..._sports_data_schema.sql` tenga las tres líneas `alter table <tabla> enable row level security;` (una por tabla), sin errores de tipeo en el nombre de la tabla.

## Nota sobre los datos

Todos los datos de `supabase/seed.sql` son ficticios (equipos y partidos inventados bajo `provider = 'local-fixtures'`) y existen únicamente para desarrollo local. `db reset --local` los destruye y recrea cada vez que se corre — no hay ningún dato real ni de producción involucrado en este flujo.
