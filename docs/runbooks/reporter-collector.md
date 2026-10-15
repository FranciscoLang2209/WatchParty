# Runbook: colector de los cinco KPIs iniciales del reporter (WAT-199)

El colector extrae, sondea, calcula y valida los cinco KPIs técnicos y de salud de ADR-05 rev. 2.0 y devuelve un artefacto de resultados y motivos de omisión. No publica nada, no escribe en la base y no activa los diez KPIs: publicar es otra tarea.

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
| `0`    | Los cinco KPIs tienen valor.                                                                                                |
| `1`    | Falta alguna fuente o no se pudo armar el lote (fallo visible). Los archivos se escriben igual, con los motivos de omisión. |
| `2`    | `REPORTER_ENV` no es `dev` ni `prod`. No se colecta nada.                                                                   |

Este comando no publica: `published` es siempre `false`.

## Configuración por ambiente

| Variable                    | Obligatoria                    | Para qué                                                                     |
| --------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `REPORTER_ENV`              | Sí                             | Ambiente de la corrida: `dev` o `prod`. Es el `env` de las filas.            |
| `REPORTER_OUTPUT_DIR`       | No                             | Directorio de salida de los archivos (por defecto `reporter-output`).        |
| `REPORTER_API_BASE_URL`     | Sí, para los tres KPIs HTTP    | Base de la API a sondear en ese ambiente (sin ruta, sin query ni fragmento). |
| `REPORTER_DATABASE_URL`     | Sí, para `catalog_match_count` | Fuente SQL de solo lectura, ver `reporter-sql-source.md`.                    |
| `REPORTER_DATABASE_CA_CERT` | No                             | CA del servidor SQL, ver `reporter-sql-source.md`.                           |

Sin valor por defecto: lo que falte se omite con motivo. Los sondeos no usan cuentas ni tokens.

## Los cinco KPIs

Todos comparten el corte T y la fecha local (`America/Argentina/Buenos_Aires`), fijados una sola vez por corrida. Sus ids, tipos (`kind`), unidades y rangos salen del catálogo de `modules/reporting/domain/kpi-catalog.ts` (WAT-200), y la fecha local se calcula con `toArgentinaDate`: el colector no tiene copias propias.

| KPI                          | Tipo (`kind`) / unidad  | Valor                                                                                                                          |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `catalog_match_count`        | `technical` / `{match}` | Partidos distintos del catálogo al corte T (fuente SQL, WAT-198). Cero es válido solo si la consulta tuvo éxito.               |
| `health_response_latency`    | `technical` / `ms`      | Tiempo monotónico de `GET /health` hasta leer el cuerpo completo. Solo con respuesta 200.                                      |
| `health_up`                  | `health` / `1`          | `1` ante 200; `0` ante un 5xx comprobado. Otros estados (404, 429...) y la falta de respuesta se omiten: no prueban una caída. |
| `auth_guard_up`              | `health` / `1`          | `GET /matches` sin token: `1` ante 401, `0` ante cualquier otro estado recibido. Sin respuesta se omite.                       |
| `report_collection_duration` | `technical` / `s`       | Tiempo monotónico de extracción, sondeos, cálculo y validación. Excluye la publicación.                                        |

Las duraciones salen solo del reloj monotónico; el reloj de pared se usa únicamente para fijar el corte T y la fecha local. Cada sondeo tiene un timeout de 10 s.

## Motivos de omisión

| `reason`                                                                                                                         | Significado                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `api-config-missing`, `api-config-invalid`                                                                                       | `REPORTER_API_BASE_URL` falta o no es una URL `http(s)` válida.        |
| `timeout`, `network-error`                                                                                                       | El sondeo no recibió una respuesta completa.                           |
| `not-200`                                                                                                                        | `/health` respondió pero no con 200: no hay latencia.                  |
| `unexpected-status`                                                                                                              | `/health` respondió un estado que no prueba una caída (no 200 ni 5xx). |
| `invalid-value`                                                                                                                  | El valor no es finito o está fuera de dominio.                         |
| `config-missing`, `config-invalid`, `invalid-cutoff`, `connection-failed`, `permission-denied`, `query-failed`, `invalid-result` | Motivos de la fuente SQL (ver `reporter-sql-source.md`).               |
| `unexpected-error`                                                                                                               | Error no previsto de la fuente SQL; su mensaje no se informa.          |

Los motivos son fijos y sanitizados: nunca incluyen URLs, hosts, credenciales ni texto de los drivers.

## Relación con el lote

El artefacto (`results` y `omissions`) tiene la forma que espera `buildMeasurementBatch` (WAT-200), que arma las filas `kpi_id / date / env / value / run_id`, omite las fuentes inválidas y marca el fallo visible. Todos los motivos de omisión del colector están en `OMISSION_REASONS`. El colector no arma ni envía el lote: eso es de la publicación.

## Workflow diario y disparo manual (WAT-202)

`.github/workflows/reporter-collect.yml` ejecuta este comando y conserva los archivos como artifact. Después de una colecta exitosa, ejecuta `reporter:publish` únicamente si la variable del Environment `REPORTER_PUBLISH_ENABLED` vale `true`. Las credenciales centrales se entregan solo al paso de publicación. Ver [reporter-publisher.md](reporter-publisher.md).

- **Disparo:** todos los días a las **04:00 UTC (01:00 de Argentina)** y manualmente (Actions → Reporter collect → Run workflow, eligiendo `dev` o `prod`). GitHub no garantiza puntualidad exacta del schedule.
- **Programado = prod, e inerte hasta activarlo:** la corrida programada es siempre de producción y no corre hasta que exista la variable de repositorio `REPORTER_SCHEDULE_ENABLED` con valor `true`, cuando las fuentes G1/G2 estén operativas. La corrida manual está siempre disponible.
- **Ambientes aislados:** cada corrida usa el GitHub Environment `reporter-dev` o `reporter-prod` (nombres propuestos, su existencia no está confirmada) con sus propios secretos y variables. Hay **una sola corrida activa por ambiente**: una nueva espera a la que está en curso.
- **Configuración por Environment:** el secret `REPORTER_DATABASE_URL` (y opcional `REPORTER_DATABASE_CA_CERT`) y la variable `REPORTER_API_BASE_URL`. La credencial de producción no se copia a dev.
- **Fallo visible:** si falta cualquier fuente el comando sale con 1 y la corrida queda en rojo, sin `continue-on-error` ni `|| true`.
- **Artifacts:** `reporter-collection-<ambiente>-<run id>`, con los archivos de `reporter-output/` y `publication.json` cuando se publica, se suben **siempre** (también si la colección o publicación falla) y se conservan 30 días. No contienen secretos.

## Estado de la validación

Las pruebas usan fuentes simuladas. En una corrida real contra la API publicada los dos sondeos HTTP respondieron como se espera (`/health` 200 y `/matches` sin token 401). La corrida real con las cinco fuentes, incluido `catalog_match_count`, queda pendiente de la credencial SQL de WAT-192 (acceso A1): hasta entonces no se declaran las cinco fuentes operativas.

El 15/10/2026 se ejecutó correctamente la primera colecta real en `reporter-prod`: [Actions #38752013725](https://github.com/FranciscoLang2209/WatchParty/actions/runs/38752013725), con artifact conservado. Esta corrida usó la versión que solo colectaba y no acredita recepción central. La publicación se acredita por separado mediante `publication.json` con `verified: true`.
