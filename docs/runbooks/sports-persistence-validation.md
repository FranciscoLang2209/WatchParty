Claude Desktop (macOS), Connected
/

Sports persistence validation · MD

# Runbook: validación de persistencia e integración del backend (WAT-109)

Este runbook documenta la validación, en un entorno local desechable, de la cadena completa migración → seed → permisos → persistencia → reinicio de API → lectura HTTP autenticada. **Todo lo que describe corrió exclusivamente contra los contenedores Docker de una máquina local** — no toca ningún proyecto remoto ni de producción.

No agrega funcionalidad: consolida evidencia verificable de WAT-103, WAT-106 y WAT-96. WAT-107 (importación real) todavía no está integrado — ver la sección correspondiente.

## SHA validado

`1a62db4` (merge de PR #31, `feature/wat-106-supabase-match-store`, que integra WAT-106 sobre WAT-103). Esta misma rama (`wat-109-...`) agrega, sobre ese SHA, un fix chico encontrado durante esta validación (ver "Hallazgo y fix" más abajo) y este runbook.

## Entorno de la validación

Docker Desktop local (macOS), Node 24.19.0 vía `nvm`, pnpm 10.34.0 vía Corepack. `apps/api/.env` con `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` de la instancia local (nunca comiteado).

## 1. Levantar y resetear el entorno local

```sh
pnpm supabase:start
pnpm exec supabase db reset --local
pnpm supabase:status
```

`db reset --local` reaplica las migraciones de `supabase/migrations/` (esquema de datos deportivos, funciones de lease, y la función `upsert_match_fixture` de WAT-106) y `supabase/seed.sql` sobre el contenedor de Postgres local. Ver `docs/runbooks/sports-data-local.md` para el detalle de cada migración. El flag `--local` garantiza que esto corre solo contra Docker local — no hay forma de que afecte un proyecto Supabase remoto.

**Resultado:** ejecutado sin errores.

## 2. Migraciones, seed, permisos y persistencia (WAT-103 / WAT-106)

```sh
pnpm --filter @watchparty/api verify:sports-data
```

Corrida real contra el esquema local. Resultado: **todos los chequeos pasaron** (constraints, RLS/permisos de `teams`/`matches`/`provider_sync_state`, ciclo de vida del lease, y — nuevo en WAT-106 — `upsertFixture`/`findById` del `SupabaseMatchStore`). Extracto relevante (sanitizado, sin datos sensibles):

```
[OK] FK rechaza home_team_id inexistente — ... foreign key constraint "matches_home_team_id_fkey"
[OK] FK rechaza away_team_id inexistente — ... foreign key constraint "matches_away_team_id_fkey"
[OK] RLS: anon no puede leer "matches" — Postgres devolvió: permission denied for table matches (code=42501)
[OK] RLS: un usuario autenticado no puede leer "matches" — Postgres devolvió: permission denied for table matches (code=42501)
[OK] RLS: service_role sí puede leer "matches" — Filas devueltas: 1
[OK] upsertFixture: la primera importación crea el partido y resuelve nombres desde las relaciones
[OK] upsertFixture: reimportar el mismo (provider, externalId) conserva el UUID interno
[OK] upsertFixture: el rollback revierte también el equipo creado antes de que fallara el partido — filas encontradas=0 (esperado: 0)
[OK] findById: devuelve null ante un id inexistente

Todos los chequeos pasaron.
```

Esto confirma, contra el esquema real (no un mock), algo que había quedado señalado como riesgo sin confirmar en la revisión de WAT-106: el nombre de la relación PostgREST usada para el join `matches` ↔ `teams` (`matches_home_team_id_fkey` / `matches_away_team_id_fkey`) es correcto.

## 3. Reinicio de API y lectura HTTP autenticada (WAT-96)

```sh
pnpm dev:api
# en otra terminal, con la API ya arriba:
pnpm --filter @watchparty/api smoke:auth-matches
```

**Primera corrida — encontró un bug real:**

```
[OK] GET /matches (con token) — esperado 200, obtuvo 200
[OK] GET /matches/:id (existente, con token) — esperado 200, obtuvo 200
[FALLÓ] GET /matches/:id (inexistente, con token) — esperado 404, obtuvo 500
[OK] GET /matches (sin token) — esperado 401, obtuvo 401
```

### Hallazgo y fix

`SupabaseMatchStore.findById()` (`apps/api/src/modules/matches/infrastructure/supabase-match-store.ts`) lanzaba una excepción genérica ante _cualquier_ error de Postgres, sin distinguir el código `22P02` (`invalid_text_representation`: Postgres lo devuelve cuando se compara una columna `uuid` contra un valor que no tiene forma de UUID — por ejemplo `no-existe-<timestamp>`, el id que usa el propio script de smoke test para simular "no existe"). El handler HTTP no atrapaba ese error, así que Express lo propagaba como 500 en vez de 404. Antes de esta migración (con `LocalMatchCatalog`), cualquier id — sin importar el formato — devolvía 404 limpio, porque era solo un `.find()` sobre un array; el cambio a ids UUID reales introdujo este caso sin que nadie lo hubiera cubierto con un test.

**Fix aplicado:** en `findById`, se agregó una constante nombrada `POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02'` (con referencia a la tabla de códigos de error de Postgres) y, si el error de Supabase tiene ese código, se devuelve `null` en vez de relanzar la excepción — mismo trato que "no encontrado".

**Segunda corrida — todos los chequeos pasaron:**

```
[OK] GET /matches (con token) — esperado 200, obtuvo 200
[OK] GET /matches/:id (existente, con token) — esperado 200, obtuvo 200
[OK] GET /matches/:id (inexistente, con token) — esperado 404, obtuvo 404
[OK] GET /matches (sin token) — esperado 401, obtuvo 401
```

Esto confirma que, tras reiniciar la API, los `GET` autenticados de lista y detalle leen datos persistidos en Supabase (no un catálogo hardcodeado en memoria): la lista devuelve los partidos ficticios sembrados por `seed.sql`, y el detalle resuelve un id real de esa tabla.

## 4. Idempotencia de importación (WAT-107) — no aplica todavía

No hay ningún importador de fixtures reales integrado en `main` a este SHA: existen piezas de infraestructura (`api-football-client.ts`, `api-football-normalizer.ts`) pero nada las conecta con `upsertFixture` para traer datos reales de API-Football. La idempotencia de `upsertFixture` en sí (reimportar el mismo `(provider, externalId)` no duplica ni cambia el UUID) **sí** quedó confirmada en el paso 2, contra datos de prueba — pero no hay todavía un flujo real de importación para ejercitar de punta a punta. Este punto queda documentado como no aplicable, sin simular evidencia que no existe.

## 5. Validación completa y apagado

```sh
pnpm validate
pnpm supabase:stop
```

**Resultado de `pnpm validate`:** verde — `format`, `lint`, `typecheck` (api + web), `test` (68 tests api, 155 tests web) y `build` (api + web), todos sin errores.

## Notas de honestidad de la evidencia

- `db reset --local` elimina solo datos locales desechables (seed ficticio bajo `provider = 'local-fixtures'` y datos de prueba bajo providers propios de los scripts de verificación, como `verify-script-store`); nunca toca un proyecto Supabase remoto.
- `pnpm validate` (format + lint + typecheck + test + build) **no certifica por sí solo** RLS, Supabase local ni el proveedor real — eso lo cubrieron los pasos 2 y 3 de este runbook.
- Niveles de evidencia diferenciados: código (SHA + `pnpm validate`, verde), base local (migración + seed + RLS + lease + store, verde, confirmado contra el esquema real), proveedor real (no aplica — WAT-107 sin integrar).
- No hubo bloqueos de Docker, entorno ni credenciales en esta corrida: todo el entorno local funcionó de punta a punta.
- El único hallazgo (bug 404→500) quedó documentado con su causa raíz y su fix, no oculto ni maquillado.
