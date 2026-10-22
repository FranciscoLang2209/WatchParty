# Runbook: fuente SQL de los KPIs de negocio del reporter (WAT-222)

Conecta los agregados `rated_match_rate` (WAT-220) y `monthly_interactions_avg` (WAT-221) al mismo adaptador SQL del reporter que `catalog_match_count` ([reporter-sql-source.md](reporter-sql-source.md)). Entrega la interfaz para el colector (T4): agregarlos al catálogo, al lote y a la publicación es esa tarea.

## Interfaz

`readBusinessAggregates(cutoff)` (`apps/api/src/modules/reporting/infrastructure/business-aggregates-source.ts`):

- Usa la misma configuración (`REPORTER_DATABASE_URL`, `REPORTER_DATABASE_CA_CERT`), el mismo TLS `verify-full` y los mismos usuarios prohibidos que la fuente de `catalog_match_count`. No hay otra credencial ni valor por defecto.
- Abre **una** conexión y ejecuta, con el mismo corte T, solo los agregados autorizados:

  ```sql
  select value, omission_reason from reporting.rated_match_rate($1::timestamptz)
  select value, omission_reason from reporting.monthly_interactions_avg($1::timestamptz)
  ```

- **No lanza.** Devuelve un desenlace por KPI:

  ```ts
  {
    rated_match_rate: { ok: true, value: 40, unit: '%' },
    monthly_interactions_avg: { ok: false, reason: 'no-denominator' },
  }
  ```

| KPI                        | Unidad                 | Valor válido               |
| -------------------------- | ---------------------- | -------------------------- |
| `rated_match_rate`         | `%`                    | Finito, entre 0 y 100      |
| `monthly_interactions_avg` | `{interaction}/{user}` | Finito, ≥ 0, con decimales |

## Motivos de omisión

Códigos fijos: nunca incluyen la URL, el host, el usuario, la contraseña ni el texto del driver.

| `reason`            | Alcance     | Cuándo                                                                                |
| ------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `config-missing`    | Ambos KPIs  | Falta `REPORTER_DATABASE_URL`.                                                        |
| `config-invalid`    | Ambos KPIs  | URL mal formada, sin `sslmode=verify-full`, usuario privilegiado o CA que no es PEM.  |
| `invalid-cutoff`    | Ambos / uno | El corte T no es válido o es futuro (en Node, o según el reloj de la base).           |
| `connection-failed` | Ambos KPIs  | Red, TLS o timeout al conectar.                                                       |
| `permission-denied` | Ambos / uno | Login rechazado (`28xxx`, ambos) o falta `EXECUTE` sobre ese agregado (`42501`, uno). |
| `query-failed`      | Ese KPI     | La consulta falló (función inexistente, timeout, etc.).                               |
| `invalid-result`    | Ese KPI     | Sin filas, valor no numérico o no finito, fuera de dominio, o motivo desconocido.     |
| `no-denominator`    | Ese KPI     | El agregado respondió, pero el mes no tiene base para calcularlo.                     |

`no-denominator` es nuevo respecto de la fuente de `catalog_match_count`. Para publicarlo como motivo, el colector (T4) tiene que sumarlo a `OMISSION_REASONS`; si no, el lote lo reemplaza por `unknown-reason`.

## Lectura real saneada

```sh
REPORTER_DATABASE_URL='<credencial del reporter>' pnpm --filter @watchparty/api reporter:verify-business
```

Con la credencial del reporter (nunca la de `postgres`): lee ambos agregados y comprueba que ese rol recibe `42501` al intentar leer `public.watched_matches`, `public.match_ratings`, `public.room_comments` y `reporting.technical_accounts`. Imprime solo los valores agregados y códigos. Sale con `0` si los dos agregados respondieron (con valor o `no-denominator`) y todas las lecturas directas fueron denegadas.

## Estado de la validación

Las pruebas unitarias (`business-aggregates-source.test.ts`) usan un cliente SQL falso. Los agregados y sus permisos se verificaron en local (`verify:rated-match-rate`, `verify:monthly-interactions-avg`) y en producción con `postgres` al aplicar las migraciones: `watchparty_reporter` tiene `USAGE` + `EXECUTE` y no tiene `SELECT` sobre las tablas. La lectura real con la credencial del reporter queda pendiente de esa credencial (WAT-193/WAT-194).
