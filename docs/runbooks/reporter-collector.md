# Runbook: colector de los cinco KPIs iniciales del reporter (WAT-199)

El colector extrae, sondea, calcula y valida los cinco KPIs técnicos y de salud de ADR-05 rev. 2.0 y devuelve un artefacto de resultados y motivos de omisión. No publica nada, no escribe en la base y no activa los diez KPIs: publicar es otra tarea.

## Cómo ejecutarlo

```sh
pnpm --filter @watchparty/api reporter:collect
```

Imprime el artefacto como JSON por la salida estándar. Un KPI omitido no es un fallo del comando: queda en `omissions` con su motivo. El comando solo sale con código 1 ante un error inesperado.

## Configuración por ambiente

| Variable                    | Obligatoria                    | Para qué                                                                     |
| --------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
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

## Estado de la validación

Las pruebas usan fuentes simuladas. En una corrida real contra la API publicada los dos sondeos HTTP respondieron como se espera (`/health` 200 y `/matches` sin token 401). La corrida real con las cinco fuentes, incluido `catalog_match_count`, queda pendiente de la credencial SQL de WAT-192 (acceso A1): hasta entonces no se declaran las cinco fuentes operativas.
