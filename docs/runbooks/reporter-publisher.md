# Runbook: publicador REST del reporter hacia la plataforma central (WAT-201)

Documenta el cliente que envía un lote de mediciones al PostgREST central. Es solo el cliente: la activación real depende de las credenciales centrales (WAT-194) y de la verificación de la recepción (WAT-209). Las pruebas usan un servidor simulado local y **no son evidencia de recepción**.

## Qué hace

`publishMeasurements(rows)` (`apps/api/src/modules/reporting/infrastructure/central-measurement-publisher.ts`) envía un lote ya construido (WAT-200) con:

```text
POST {REPORTER_CENTRAL_URL}/rest/v1/measurement?on_conflict=project_id,kpi_id,date,env
apikey: <clave publicable>
X-Project-Key: <clave privada del proyecto, por ambiente>
Prefer: resolution=ignore-duplicates
Content-Type: application/json
```

- El cuerpo es el JSON de `serializeBatchPayload`: un array de 1 a 10 filas con solo `kpi_id`, `date`, `env`, `value` y `run_id`. Un lote inválido (valor no finito, campo prohibido, posiciones vacías, KPI fuera del catálogo) no se envía.
- **Inmutabilidad:** se usa `ignore-duplicates`, nunca `merge-duplicates`, PATCH ni PUT. El primer valor aceptado se conserva; reenviar no duplica ni corrige.

## Parámetros por ambiente

Se leen del entorno del proceso y no se imprimen ni se archivan. Cada ambiente (`dev`, `prod`) tiene sus propios valores: probar en uno no registra ni publica en el otro.

| Variable                           | Obligatoria | Contenido                                                                   |
| ---------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `REPORTER_CENTRAL_URL`             | Sí          | URL base de la plataforma central, solo el origen (sin ruta ni query).      |
| `REPORTER_CENTRAL_PUBLISHABLE_KEY` | Sí          | Clave publicable (`apikey`). Es pública.                                    |
| `REPORTER_CENTRAL_PROJECT_KEY`     | Sí          | Clave privada del proyecto para ese ambiente (`X-Project-Key`). Es secreto. |

Los nombres llevan prefijo `REPORTER_CENTRAL_` a propósito: la plataforma central es independiente de la base de WatchParty y no debe confundirse con `SUPABASE_URL` ni con sus claves. Los valores los entrega la cátedra (WAT-194); la carga como secretos de un GitHub Environment por ambiente corresponde al workflow.

Reglas que el cliente hace cumplir:

- La URL debe ser `https` (el `http` solo se acepta en loopback, para el servidor simulado), sin credenciales, ruta, query ni fragmento.
- Ninguna clave puede ser de rol de servicio (`sb_secret_…` o un JWT con `role: service_role`): se rechaza la configuración. Nunca se usa `SUPABASE_SERVICE_ROLE_KEY` ni ninguna otra variable como reemplazo.
- Las redirecciones no se siguen: reenviarían las claves a otro destino.

## Reintentos

- Hasta **3 intentos totales**, siempre con el **mismo JSON y el mismo `run_id`**, con una espera fija de 1 s y 2 s entre ellos.
- Se reintenta **solo** ante falta de respuesta (red o timeout de 10 s) o 5xx.
- Un **4xx falla en el primer intento, sin reintento** (incluido 429): se corrige la causa antes de repetir. Una redirección tampoco se reintenta.

## Resultado archivable

El resultado se archiva con `JSON.stringify` y contiene solo códigos fijos, estados HTTP, el `run_id`, el ambiente y la cantidad de filas; nunca claves, URLs, cuerpos de respuesta ni mensajes del driver:

```json
{
  "ok": false,
  "reason": "server-error",
  "run_id": "…",
  "env": "dev",
  "rows": 5,
  "attempts": [{ "attempt": 1, "outcome": "server-error", "status": 503 }],
  "verified": false
}
```

| `reason`            | Cuándo                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| `config-missing`    | Falta alguna de las tres variables. No se hace ninguna petición.         |
| `config-invalid`    | URL no válida o insegura, o una clave parece de rol de servicio.         |
| `invalid-batch`     | El lote no pasa la validación del contrato. No se hace ninguna petición. |
| `network-error`     | No hubo respuesta tras los intentos permitidos.                          |
| `timeout`           | El último intento superó el tiempo máximo.                               |
| `server-error`      | 5xx en todos los intentos.                                               |
| `client-error`      | 4xx: no se reintenta.                                                    |
| `unexpected-status` | Estado que no es ni 2xx, ni 4xx, ni 5xx (por ejemplo una redirección).   |

`verified` es siempre `false`: un HTTP 2xx **no** confirma la recepción de los valores. Confirmarla consultando las mediciones propias es parte de la activación (WAT-209).

## Publicación y verificación desde Actions (WAT-209)

`reporter:collect` conserva su comportamiento de solo lectura. El workflow llama después a:

```sh
pnpm --filter @watchparty/api reporter:publish
```

El comando reutiliza `payload.json` y exige un `archive.json` completo, no simulado y del mismo ambiente. Antes del POST confirma por `current_project` que la clave pertenece a WatchParty (equipo 5) y al ambiente esperado. Después consulta las mediciones propias del día y compara los identificadores, valores y `run_id` de todas las filas del lote. Un HTTP exitoso con valores distintos o ausentes falla. Escribe el resultado sanitizado en `publication.json`; no modifica `result.json`, que sigue describiendo solamente la colecta.

Configurar en el GitHub Environment correspondiente:

- Los tres secretos `REPORTER_CENTRAL_URL`, `REPORTER_CENTRAL_PUBLISHABLE_KEY` y `REPORTER_CENTRAL_PROJECT_KEY` de la tabla anterior.
- La variable `REPORTER_PUBLISH_ENABLED=true` para habilitar el paso. Sin ella el workflow solo colecta.
- La variable `REPORTER_API_BASE_URL` y los secretos SQL ya documentados para colectar.

El cron requiere además la variable de **repositorio** `REPORTER_SCHEDULE_ENABLED=true`; el horario sigue siendo 04:00 UTC / 01:00 Argentina. `workflow_dispatch` permite probar la rama de integración antes del merge. La publicación programada usa el código de `main`.

El catálogo se registra una vez por ambiente, antes del primer envío, con los registros que devuelve `prepareCatalogRegistration(env)`. El catálogo de dev no habilita prod. **Cada KPI nuevo del catálogo (por ejemplo `catalog_query_latency`, `catalog_read_up`, `database_up`, `rated_match_rate` o `monthly_interactions_avg`) debe registrarse en el catálogo central de cada ambiente antes de que corra la publicación que lo incluye:** un lote con un KPI no registrado se rechaza completo (409), también los KPIs que ya estaban registrados. Los dos de negocio se registran con `kind: business`, unidades `%` y `{interaction}/{user}`; el lote completo tiene hasta diez filas. Las claves y URLs centrales no reemplazan las de la base propia de WatchParty.

Si el POST tuvo éxito y falló la verificación por red, conservar el artifact y reintentar **el mismo** `payload.json` y `archive.json`. Una nueva colecta genera otro UUID y latencias nuevas: si el primer lote ya existe, se conserva y la comparación del nuevo lote falla. No cambiar ni borrar las mediciones recibidas para forzar un resultado exitoso.

## Comprobaciones operativas — 15/10/2026

- Identidad central verificada: WatchParty, equipo 5, en dev y prod; cinco KPIs registrados en cada catálogo.
- En dev: lote con un KPI desconocido rechazado con 409; clave dev enviando `env=prod` rechazada con 401. La consulta antes/después confirmó que ninguna medición se insertó en estas pruebas.
- Secretos centrales de prod cargados en `reporter-prod`; claves fuera del código y artifacts.
- Colecta real desde Actions: [#38752013725](https://github.com/FranciscoLang2209/WatchParty/actions/runs/38752013725).
- Publicación real y recepción verificadas desde Actions: [#38753081458](https://github.com/FranciscoLang2209/WatchParty/actions/runs/38753081458), commit `988d6a2`, fecha local `2026-10-15`, cinco valores y UUID común `835f5df3-2174-4eb5-8829-a390618beec7`. El artifact incluye `publication.json` con `ok: true` y `verified: true`.
- Reenvío del mismo payload con el comando de publicación: exitoso, sin cambiar cantidad de filas, valores, UUID ni timestamps de recepción.
- El panel público mostraba «Todavía no hay días evaluables» al comprobar la recepción. El calendario de evaluación lo configura la cátedra; recepción verificada no implica puntaje hasta que exista un día evaluable.
