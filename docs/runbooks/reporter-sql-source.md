# Runbook: fuente SQL de lectura del reporter, `catalog_match_count` (WAT-198)

Documenta el adaptador SQL que lee el KPI `catalog_match_count` (ADR-05): la cantidad de partidos distintos del catálogo persistido al corte T, unidad `{match}`. Es solo la fuente de lectura: el colector, el lote, el publicador y el workflow del reporter son tareas aparte.

## Qué hace

`readCatalogMatchCount(cutoff)` (`apps/api/src/modules/reporting/infrastructure/catalog-match-count-source.ts`) abre una conexión TLS con el usuario de solo lectura del reporter, ejecuta una única consulta y la cierra:

```sql
select reporting.catalog_match_count($1::timestamptz) as value
```

- El usuario del reporter solo puede ejecutar ese agregado: no lee tablas directamente. La función y el rol se provisionan en la base, fuera de este repo (acceso G1 / WAT-192); esta tarea no crea migraciones, roles ni vistas.
- No usa fixtures ni filas personales: cuenta IDs de partidos del catálogo.
- Devuelve `{ value, unit: '{match}' }`, con `value` entero finito y no negativo. Cero es válido solo cuando la consulta tuvo éxito y respondió cero.

## Parámetros por ambiente

Se leen del entorno del proceso. Nunca van al frontend, al repo, a la documentación ni a los logs.

| Variable                    | Obligatoria | Qué contiene                                                                                                                                   |
| --------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `REPORTER_DATABASE_URL`     | Sí          | Conexión del usuario dedicado de lectura, con `sslmode=verify-full`. Secret de GitHub Environment.                                             |
| `REPORTER_DATABASE_CA_CERT` | No          | CA del servidor en PEM. Hace falta si el certificado del destino no está en el almacén de confianza del sistema. Secret de GitHub Environment. |

Formato de `REPORTER_DATABASE_URL` (los valores entre `<>` se obtienen de forma privada del destino confirmado):

```text
postgresql://<usuario-reporter>:<contraseña-percent-encoded>@<host>:<puerto>/<base>?sslmode=verify-full
```

- Con pooler, el usuario llega como `<rol>.<ref>`. Se verifica el TLS cliente→pooler, no solo el de la base.
- `sslmode=verify-full` es obligatorio: valida la CA y el hostname. Con cualquier otro valor, o sin él, el adaptador falla con `config-invalid` en vez de conectar sin verificar.
- Se rechazan los usuarios `postgres`, `service_role` y `supabase_admin` (también con sufijo de pooler).
- La contraseña va percent-encoded. No se escribe como argumento de shell, comentario ni archivo.

Un GitHub Environment por ambiente, con los mismos nombres de secreto en cada uno (los nombres `reporter-prod` y `reporter-dev` son propuestos; su existencia no está confirmada y se acuerdan con WAT-202). La credencial de producción no se copia a dev: el destino y la credencial de dev se confirman por separado.

## Ausencia segura de credencial

Sin `REPORTER_DATABASE_URL` el adaptador falla antes de abrir ninguna conexión. No hay valor por defecto ni reemplazo: no se usa `SUPABASE_SERVICE_ROLE_KEY` ni `DATABASE_URL`.

Toda falla sale como `CatalogMatchCountSourceError` con un `reason` fijo, pensado para omitir el KPI con motivo. Ninguna se convierte en cero:

| `reason`            | Cuándo                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| `config-missing`    | Falta `REPORTER_DATABASE_URL`.                                                       |
| `config-invalid`    | URL mal formada, sin `sslmode=verify-full`, usuario prohibido o CA que no es PEM.    |
| `invalid-cutoff`    | El corte T no es una fecha válida o es futuro.                                       |
| `connection-failed` | Red, TLS (certificado u hostname no verificados) o timeout al conectar.              |
| `permission-denied` | Rol sin LOGIN o contraseña rechazada (`28xxx`), o privilegio insuficiente (`42501`). |
| `query-failed`      | La consulta falló (función inexistente, timeout, etc.).                              |
| `invalid-result`    | Sin filas, nulo, negativo, decimal, no finito o fuera del rango de enteros seguros.  |

Los mensajes son fijos: no incluyen la URL, el host, el usuario, la contraseña ni el texto del driver, y el error no conserva la causa original.

## Estado de la validación

Las pruebas (`catalog-match-count-source.test.ts`) usan un cliente SQL falso: no tocan la red ni una base. La corrida real de lectura todavía no se hizo: depende de la credencial SQL de lectura y del TLS que habilita WAT-192 (la conexión previa con `SET ROLE` no reemplaza la prueba de login real).

Cuando WAT-192 esté habilitado, la corrida real usa un corte T explícito, finito y no futuro, y se adjunta solo evidencia saneada: ambiente, nombre del secreto, responsable y fecha, aceptación de identidad y TLS, y el resultado de la consulta (conteo). Nunca contraseñas, tokens, hashes ni URLs con credenciales.
