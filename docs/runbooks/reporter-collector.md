# Runbook: colector de los cinco KPIs iniciales del reporter (WAT-199)

El colector extrae, sondea, calcula y valida los KPIs técnicos y de salud de ADR-05 rev. 2.0 y devuelve un artefacto de resultados y motivos de omisión. No publica nada, no escribe en la base y no activa los diez KPIs: publicar es otra tarea.

## Cómo ejecutarlo

```sh
pnpm --filter @watchparty/api reporter:collect
```

Arma el lote con el catálogo del reporter (WAT-200) y deja tres archivos en `REPORTER_OUTPUT_DIR` (por defecto `reporter-output`, ignorado por git):

| Archivo        | Contenido                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------- |
| `payload.json` | El JSON del lote que se enviaría: solo las filas `kpi_id / date / env / value / run_id`.  |
| `archive.json` | El corte T, la fecha local, el lote y los motivos de omisión (`serializeArchive`).        |
| `result.json`  | El resultado de la corrida y los motivos, siempre presente aunque no se pueda armar lote. |

`payload.json` y `archive.json` solo existen si hay al menos un KPI con valor. Los tres contienen únicamente códigos fijos, números, el `run_id` y el ambiente: nunca claves, URLs ni texto de error.

Códigos de salida:

| Código | Significado                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `0`    | Todos los KPIs del catálogo tienen valor.                                                                                   |
| `1`    | Falta alguna fuente o no se pudo armar el lote (fallo visible). Los archivos se escriben igual, con los motivos de omisión. |
| `2`    | `REPORTER_ENV` no es `dev` ni `prod`. No se colecta nada.                                                                   |

Este comando no publica: `published` es siempre `false`.

## Configuración por ambiente

| Variable                    | Obligatoria                                                             | Para qué                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REPORTER_ENV`              | Sí                                                                      | Ambiente de la corrida: `dev` o `prod`. Es el `env` de las filas.                                                                                                                                                                     |
| `REPORTER_OUTPUT_DIR`       | No                                                                      | Directorio de salida de los archivos (por defecto `reporter-output`).                                                                                                                                                                 |
| `REPORTER_API_BASE_URL`     | Sí, para los cuatro KPIs HTTP                                           | Base de la API a sondear en ese ambiente (sin query ni fragmento). Debe ser `https`: el sondeo autenticado manda el token en un header. `http` se admite solo en loopback (`localhost`, `127.0.0.1`, `[::1]`), para desarrollo local. |
| `REPORTER_DATABASE_URL`     | Sí, para `catalog_match_count`, `catalog_query_latency` y `database_up` | Fuente SQL de solo lectura, ver `reporter-sql-source.md`.                                                                                                                                                                             |
| `REPORTER_DATABASE_CA_CERT` | No                                                                      | CA del servidor SQL, ver `reporter-sql-source.md`.                                                                                                                                                                                    |
| `REPORTER_PROBE_AUTH_URL`   | Sí, para `catalog_read_up`                                              | URL del proyecto Supabase de WatchParty donde vive la cuenta técnica (solo el origen). Pública.                                                                                                                                       |
| `REPORTER_PROBE_ANON_KEY`   | Sí, para `catalog_read_up`                                              | Clave anónima (publicable) de ese proyecto, la misma que usa la web. Pública; no puede ser de rol de servicio.                                                                                                                        |
| `REPORTER_PROBE_EMAIL`      | Sí, para `catalog_read_up`                                              | Correo de la cuenta técnica de lectura de ese ambiente.                                                                                                                                                                               |
| `REPORTER_PROBE_PASSWORD`   | Sí, para `catalog_read_up`                                              | Contraseña de esa cuenta. Es un secreto.                                                                                                                                                                                              |

Sin valor por defecto: lo que falte se omite con motivo. Los sondeos de `/health` y de `GET /matches` sin token no usan cuentas ni tokens; solo `catalog_read_up` usa la cuenta técnica.

### Disponibilidad de la base (`database_up`)

Usa el mismo rol de solo lectura, la misma conexión TLS verificada y la misma configuración que `catalog_match_count` (`REPORTER_DATABASE_URL`), pero con su propia conexión y una lectura que no toca ningún objeto: `select 1`. **No hace falta conceder acceso a ninguna tabla**, y no hay migración. Es independiente de `/health` y de la función del catálogo: puede estar en `1` con `/health` caído, y al revés.

- **`1`:** la lectura mínima termina bien.
- **`0` (indisponibilidad comprobada):** solo ante una **respuesta explícita de la base** o un corte de una **sesión ya autenticada**: la base informa que no atiende (SQLSTATE `57P01`, `57P02`, `57P03`, `53300` o `08006`), o, con TLS y autenticación ya completados, deja de responder o corta la sesión.
- **Se omite con motivo, nunca `0`:** todo lo que ocurre **antes de autenticar** sin una respuesta de la base: rechazo o corte de la conexión (`ECONNREFUSED`, `ECONNRESET`, `EPIPE`), tiempo agotado, DNS, rutas inalcanzables, y fallos de certificado o TLS (`connection-failed`). Además, configuración faltante o inválida (`config-missing`, `config-invalid`), rechazo de acceso o de permisos (`28xxx`, `42501` → `permission-denied`), otros errores de SQL (`query-failed`) y un resultado inesperado (`invalid-result`).
- **Por qué:** antes de autenticar no hay ninguna prueba sobre la base. Un puerto equivocado en la URL, un firewall o un proxy producen exactamente el mismo error que una base caída, así que informar `0` convertiría un error de configuración en una falsa alarma. Una caída que se vea como rechazo de conexión queda como fallo visible de la corrida (omitido con motivo), no como `0`.

### Cuenta técnica de lectura (`catalog_read_up`)

- Es **una cuenta propia del reporter, por ambiente**, ya creada en Supabase Auth del proyecto de WatchParty. Nunca una cuenta personal. El comando **no crea usuarios**: inicia sesión con la contraseña (`signInWithPassword`) y, a diferencia de `smoke:auth-matches`, no hace `signUp`.
- Debe estar registrada en `reporting.technical_accounts` (WAT-220) para que los KPIs de negocio la excluyan.
- En cada corrida se inicia sesión de nuevo, el token vive solo lo que dura el sondeo (nunca se imprime ni se guarda) y al terminar se cierra solo esa sesión (`scope: local`). No hace falta renovarlo. Cada pedido a Supabase Auth (inicio y cierre de sesión) tiene un tiempo máximo de 10 s: si Auth no responde, el KPI se omite como `auth-unavailable` y la colecta sigue, y un cierre colgado no impide devolver el resultado del sondeo.
- Crear la cuenta, cargar sus secretos en el Environment y registrarla es coordinación de accesos (WAT-193 y WAT-194), no de este código. Hasta contar con ella, el KPI se omite con `config-missing`.

## Los KPIs

Todos comparten el corte T y la fecha local (`America/Argentina/Buenos_Aires`), fijados una sola vez por corrida. Sus ids, tipos (`kind`), unidades y rangos salen del catálogo de `modules/reporting/domain/kpi-catalog.ts` (WAT-200), y la fecha local se calcula con `toArgentinaDate`: el colector no tiene copias propias.

| KPI                          | Tipo (`kind`) / unidad  | Valor                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog_match_count`        | `technical` / `{match}` | Partidos distintos del catálogo al corte T (fuente SQL, WAT-198). Cero es válido solo si la consulta tuvo éxito.                                                                                                                                                                                                        |
| `health_response_latency`    | `technical` / `ms`      | Tiempo monotónico de `GET /health` hasta leer el cuerpo completo. Solo con respuesta 200.                                                                                                                                                                                                                               |
| `catalog_query_latency`      | `technical` / `ms`      | Tiempo monotónico de la consulta SQL del catálogo (la misma que trae `catalog_match_count`) hasta recibir su resultado, sin contar la conexión. Solo si la consulta termina bien; si falla la fuente, los permisos o la configuración, se omite con el mismo motivo que el conteo. No es la duración total del reporte. |
| `health_up`                  | `health` / `1`          | `1` ante 200; `0` ante un 5xx comprobado. Otros estados (404, 429...) y la falta de respuesta se omiten: no prueban una caída.                                                                                                                                                                                          |
| `database_up`                | `health` / `1`          | Lectura SQL mínima (`select 1`) con el rol y la conexión TLS del reporter, en su propia conexión: `1` ante éxito; `0` solo ante una indisponibilidad comprobada (ver abajo). Permisos, configuración y fallos atribuibles al reporter se omiten con motivo. `/health` no la sustituye.                                  |
| `catalog_read_up`            | `health` / `1`          | `GET /matches` con el token de la cuenta técnica: `1` ante un 200 con el esquema esperado (también con la lista vacía); `0` ante un 5xx o un 200 cuya respuesta no cumple el contrato. Un 401/403 con el token recién emitido, otros estados, la falta de respuesta o la falta de token se omiten con motivo.           |
| `auth_guard_up`              | `health` / `1`          | `GET /matches` sin token: `1` ante 401, `0` ante cualquier otro estado recibido. Sin respuesta se omite.                                                                                                                                                                                                                |
| `report_collection_duration` | `technical` / `s`       | Tiempo monotónico de extracción, sondeos, cálculo y validación. Excluye la publicación.                                                                                                                                                                                                                                 |

Las duraciones salen solo del reloj monotónico; el reloj de pared se usa únicamente para fijar el corte T y la fecha local. Cada sondeo tiene un timeout de 10 s.

## Motivos de omisión

| `reason`                                                                                                                         | Significado                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `api-config-missing`, `api-config-invalid`                                                                                       | `REPORTER_API_BASE_URL` falta o no es válida: tiene que ser `https` (o `http` en loopback) y sin query ni fragmento. |
| `timeout`, `network-error`                                                                                                       | El sondeo no recibió una respuesta completa.                                                                         |
| `not-200`                                                                                                                        | `/health` respondió pero no con 200: no hay latencia.                                                                |
| `unauthorized`                                                                                                                   | `GET /matches` respondió 401/403 a un token recién emitido (credencial o permisos, no una caída).                    |
| `credentials-invalid`, `auth-unavailable`                                                                                        | Supabase Auth rechazó las credenciales de la cuenta técnica, o no estaba disponible (429, 5xx o sin respuesta).      |
| `unexpected-status`                                                                                                              | `/health` respondió un estado que no prueba una caída (no 200 ni 5xx).                                               |
| `invalid-value`                                                                                                                  | El valor no es finito o está fuera de dominio.                                                                       |
| `config-missing`, `config-invalid`, `invalid-cutoff`, `connection-failed`, `permission-denied`, `query-failed`, `invalid-result` | Motivos de la fuente SQL (ver `reporter-sql-source.md`).                                                             |
| `unexpected-error`                                                                                                               | Error no previsto de la fuente SQL; su mensaje no se informa.                                                        |

Los motivos son fijos y sanitizados: nunca incluyen URLs, hosts, credenciales ni texto de los drivers.

## Relación con el lote

El artefacto (`results` y `omissions`) tiene la forma que espera `buildMeasurementBatch` (WAT-200), que arma las filas `kpi_id / date / env / value / run_id`, omite las fuentes inválidas y marca el fallo visible. Todos los motivos de omisión del colector están en `OMISSION_REASONS`. El colector no arma ni envía el lote: eso es de la publicación.

## Workflow diario y disparo manual (WAT-202)

`.github/workflows/reporter-collect.yml` ejecuta este comando y conserva los archivos como artifact. Después de una colecta exitosa, ejecuta `reporter:publish` únicamente si la variable del Environment `REPORTER_PUBLISH_ENABLED` vale `true`. Las credenciales centrales se entregan solo al paso de publicación. Ver [reporter-publisher.md](reporter-publisher.md).

- **Disparo:** todos los días a las **04:00 UTC (01:00 de Argentina)** y manualmente (Actions → Reporter collect → Run workflow, eligiendo `dev` o `prod`). GitHub no garantiza puntualidad exacta del schedule.
- **Programado = prod, e inerte hasta activarlo:** la corrida programada es siempre de producción y no corre hasta que exista la variable de repositorio `REPORTER_SCHEDULE_ENABLED` con valor `true`, cuando las fuentes G1/G2 estén operativas. La corrida manual está siempre disponible.
- **Ambientes aislados:** cada corrida usa el GitHub Environment `reporter-dev` o `reporter-prod` (nombres propuestos, su existencia no está confirmada) con sus propios secretos y variables. Hay **una sola corrida activa por ambiente**: una nueva espera a la que está en curso.
- **Configuración por Environment:** el secret `REPORTER_DATABASE_URL` (y opcional `REPORTER_DATABASE_CA_CERT`) y las variables `REPORTER_API_BASE_URL`, `REPORTER_PROBE_AUTH_URL` y `REPORTER_PROBE_ANON_KEY`, más los secretos `REPORTER_PROBE_EMAIL` y `REPORTER_PROBE_PASSWORD` de la cuenta técnica. La credencial de producción no se copia a dev.
- **Fallo visible:** si falta cualquier fuente el comando sale con 1 y la corrida queda en rojo, sin `continue-on-error` ni `|| true`.
- **Artifacts:** `reporter-collection-<ambiente>-<run id>`, con los archivos de `reporter-output/` y `publication.json` cuando se publica, se suben **siempre** (también si la colección o publicación falla) y se conservan 30 días. No contienen secretos.

## Estado de la validación

Las pruebas usan fuentes simuladas. En una corrida real contra la API publicada los dos sondeos HTTP respondieron como se espera (`/health` 200 y `/matches` sin token 401). La corrida real con las cinco fuentes, incluido `catalog_match_count`, queda pendiente de la credencial SQL de WAT-192 (acceso A1): hasta entonces no se declaran las cinco fuentes operativas.

El 15/10/2026 se ejecutó correctamente la primera colecta real en `reporter-prod`: [Actions #38752013725](https://github.com/FranciscoLang2209/WatchParty/actions/runs/38752013725), con artifact conservado. Esta corrida usó la versión que solo colectaba y no acredita recepción central. La publicación se acredita por separado mediante `publication.json` con `verified: true`.
