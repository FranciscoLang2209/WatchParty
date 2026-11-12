# Runbook: enriquecer partidos históricos con estadísticas y goles (API-Football)

Agrega **posesión, remates, remates al arco, córners, faltas y la cronología de goles** a partidos
terminados que **ya están guardados**, usando API-Football (plan Free) como fuente complementaria.
football-data.org sigue alimentando el catálogo y el marcador: este comando **no importa fixtures,
no crea partidos ni equipos y no toca el marcador**. Cada partido conserva su UUID, sus salas,
comentarios, calificaciones, reseñas e historial.

> **Alcance real.** El plan Free de API-Football anuncia acceso a las temporadas 2022, 2023 y 2024
> (a verificar en la cuenta). **No cubre 2025 ni 2026**: esos partidos no se enriquecen. Que una
> liga declare `statistics_fixtures: true` tampoco garantiza datos completos por partido: por eso
> cada partido informa su cobertura y nada se da por cubierto sin verlo.

## Cómo funciona

1. Una persona aprueba un **lote de correspondencias** `MATCH_ID:FIXTURE_ID` (partido interno ↔
   fixture de API-Football). No hay búsqueda automática ni coincidencia difusa.
2. Por cada par, el comando consulta el fixture (1 pedido) y **verifica** que sea ese partido:
   competición, fecha/hora UTC (±30 min), equipos y orientación local/visitante, estado terminado
   y, cuando es comparable, el marcador. Si algo no cierra, el par se **rechaza** y se informa;
   no se gasta cuota en sus datos.
3. Si la verificación pasa, toma las estadísticas y los eventos y los normaliza. Si el propio
   fixture los trae **embebidos** (`GET /fixtures?id=` suele incluirlos) los usa sin pedidos
   extra; si no vienen, vienen vacíos o no se pueden leer, los pide a `/fixtures/statistics` y
   `/fixtures/events`. Un dato ausente es **«Sin dato»**, nunca cero; un cero real se conserva
   como `0`; los goles se concilian con el marcador del partido, y si no cierran la cronología
   queda **incompleta**.
4. Con `dry_run=false` guarda, **por partido y de forma atómica**, el vínculo y las partes
   obtenidas. Una respuesta incompleta o con error **nunca borra** lo ya confirmado: una carga
   reemplaza a la guardada solo si tiene **más cobertura**, o la **misma cobertura completa**
   (una corrección válida), o la misma cobertura no completa con **al menos tantas métricas /
   eventos**. Dos cargas parciales no son intercambiables: una con 2 métricas no pisa a otra con 8.

Cada partido consume **1 pedido** si el fixture trae estadísticas y eventos embebidos, y **3** si
hay que pedirlos aparte (los reintentos también cuentan). El resumen indica, partido por partido,
de dónde salió cada parte (`fixture` o `endpoint`). El lote admite hasta **20** correspondencias.
Solo se enriquecen partidos cuyo proveedor de origen es **football-data.org**: uno de otro
proveedor se rechaza antes de consultar (`proveedor-no-soportado`).

> **Cuota entre entornos.** El ledger de cuota (`provider_quota_ledger`, 80 por día propios) es
> **por base de datos**. Si `demo` y `Production` usan la **misma** `API_FOOTBALL_KEY`, la suma de
> ambos puede superar los 100 pedidos diarios del plan aunque cada base respete su 80. Usá claves
> separadas, o coordiná para que lo ejecutado entre los dos entornos en un mismo día no pase de 100.

## Preparación (la hace quien desarrolla, una sola vez)

1. **Aplicar la migración** `supabase/migrations/20261112120000_match_enrichment.sql` a la base de
   cada entorno, **a mano**, siguiendo `docs/runbooks/production-migrations.md`. Sin ella, ni el
   comando ni el endpoint funcionan. Es aditiva: crea 4 tablas nuevas y la función
   `apply_match_enrichment`; no modifica `matches` ni `teams`.
2. **Desplegar** la API y el frontend de este cambio (el detalle del partido pide
   `GET /matches/:matchId/historical-detail`).
3. **Secretos por entorno** en GitHub (Settings → Environments):

   | Entorno      | Secretos                                                                                                                                        |
   | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
   | `demo`       | `DEMO_SUPABASE_URL`, `DEMO_SUPABASE_SERVICE_ROLE_KEY`, `DEMO_SUPABASE_ANON_KEY`, `DEMO_WEB_ORIGIN`, `API_FOOTBALL_BASE_URL`, `API_FOOTBALL_KEY` |
   | `Production` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `WEB_ORIGIN`, `API_FOOTBALL_BASE_URL`, `API_FOOTBALL_KEY`                     |

   Los secretos no se imprimen: el comando solo informa los **nombres** que faltan.

## Armar el lote

Un par por partido, separados por comas o saltos de línea:

```
3f9c0c8e-1c1e-4a62-8f64-0a3f6f1a2b10:1145512
7a2d1b50-5c3e-4f10-9a77-2d9e4c8b1f33:1145513
```

- **`MATCH_ID`**: el UUID del partido en WatchParty. Es el que aparece en la URL del detalle
  (`/matches/<uuid>`).
- **`FIXTURE_ID`**: el id del partido en API-Football (consola de API-Football o
  `GET /fixtures?league=<liga>&season=<año>`; esa consulta también gasta cuota).
- Los ids de proveedores distintos **no coinciden**: un `MATCH_ID` no se deduce de un `FIXTURE_ID`.
- Un mismo partido con dos fixtures, o un mismo fixture en dos partidos, **invalida todo el lote**
  antes de consultar nada.
- Liga equivalente que se verifica (id de football-data.org → id de API-Football): Premier League
  `2021→39`, La Liga `2014→140`, Champions `2001→2`, Mundial `2000→1`, Eurocopa `2018→4`,
  Championship `2016→40`, Primeira Liga `2017→94`, Bundesliga `2002→78`, Serie A `2019→135`,
  Ligue 1 `2015→61`, Eredivisie `2003→88`, Brasileirão `2013→71`. Una competición fuera de la
  tabla se rechaza.
- `season` de football-data.org es un identificador opaco: **no se usa** para elegir la temporada.
  La edición queda determinada por la fecha del partido.

## Ejecutar desde GitHub (sin terminal ni cambios de código)

1. GitHub → **Actions** → **Matches enrich batch** → **Run workflow**.
2. Completar:
   - **target**: `demo` (por defecto) o `production`.
   - **batch**: el lote aprobado (obligatorio).
   - **dry_run**: marcado (por defecto) = vista previa.
3. **Primero siempre con `dry_run` marcado.** Hace las mismas consultas (**consumen cuota**) pero
   **no escribe** estadísticas ni eventos. Leer el **Summary** de la ejecución.
4. Si el resumen es el esperado, volver a ejecutar con **dry_run desmarcado** para guardar.
5. Repetir el lote es seguro: no duplica partidos, vínculos ni goles; las partes se reemplazan.

Producción exige correr desde `main` y un lote no vacío; si no, el workflow falla antes de
instalar nada. El workflow comparte el grupo de concurrencia `matches-sync-production` con la
sincronización diaria y la importación por lotes, así que nunca corre a la vez que ellas.

## Leer el resumen

Una fila por partido, con estos resultados:

| Resultado       | Significado                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `enriquecido`   | Se guardó (o se guardaría, en dry_run) al menos una parte, sin errores.                                                                         |
| `sin-cobertura` | El proveedor respondió pero sin estadísticas ni goles utilizables. Se registra el vínculo; no se guardan ceros.                                 |
| `rechazado`     | La correspondencia no se pudo verificar (fecha, equipos, orientación, competición, estado, marcador, ya vinculado a otro…). **Revisar el par.** |
| `error`         | Falló una consulta o la escritura (red, límite, plan, cuota agotada). Reintentar más tarde; nada se borra.                                      |

Cada parte (`Estadísticas`, `Goles`) informa `guardado`/`guardaria`, `conservado` (la respuesta era
menos completa que lo ya guardado), `sin-cobertura` o `error`, con su cobertura:

- **Estadísticas** `complete` (ambos equipos y las 5 métricas) o `partial`.
- **Goles** `complete` (la cronología coincide con el marcador, o es un 0–0 real) o `incomplete`.

Debajo de la tabla: enriquecidos / sin cobertura / rechazados / errores, **cuota** (pedidos de la
corrida, reservados hoy y restante informado por el proveedor) y **partidos antes/después**, que
**tiene que ser igual**: si cambia, el comando termina con error.

Después viene **«Evidencia por partido»**, ya saneada y lista para pegar en la PR o el issue: ids de
ambos sistemas, equipos de cada lado, competición/temporada del proveedor, inicios UTC, de dónde
salió cada parte, métricas presentes y ausentes, goles con su conciliación y pedidos del partido.

Códigos de salida: `0` todo bien, `1` algún partido rechazado o con error (o cambió la cantidad de
partidos), `2` configuración inválida (no se consultó ni escribió nada).

## Qué se muestra en la app

En el detalle de un partido **finalizado**: estadísticas local/visitante y goles ordenados con
autor (si se conoce), minuto y añadido (`45+2'`, `90+4'`). Se distinguen:

- **cero real** (`0`) de **«Sin dato»**;
- **cobertura restringida** (faltan métricas) y **cronología incompleta** (avisadas como tales);
- **goles del juego**, **goles anulados** y **tanda de penales** (listas separadas);
- carga y error con «Reintentar». Un partido **sin detalle cargado no muestra la sección**: la
  mayoría de los terminados no están enriquecidos y una tarjeta vacía en cada uno sería ruido.

Siempre dice la fuente (API-Football) y que son **datos históricos, sin actualización en vivo**.
La web nunca consulta al proveedor: solo lee lo guardado.

## Verificación de solo lectura (SQL)

```sql
select count(*) as partidos from matches;                                    -- igual antes y después
select provider, count(*) from match_provider_links group by provider;      -- partidos vinculados
select statistics_coverage, goals_coverage, count(*)
from match_enrichment group by 1, 2;                                        -- cobertura por partido
select match_id, count(*) from match_goal_events group by match_id;         -- goles por partido
```

## Deshacer un enriquecimiento

Borrar la fila de `match_enrichment` del partido elimina en cascada sus estadísticas y goles; el
vínculo está en `match_provider_links`. Se hace **a mano y coordinándolo**, no desde el workflow, y
no afecta al partido ni a nada social. Para volver a vincularlo a otro fixture hay que borrar antes
su vínculo.

## Límites conocidos

- La coincidencia de nombres **falla cerrado a propósito**: `Manchester City FC` ↔ `Manchester City`
  pasa (uno contiene al otro sin sufijos como «FC»), pero un **apodo** o alias distinto
  (`Wolverhampton Wanderers FC` ↔ `Wolves`) se **rechaza** como `equipos-distintos`. No es un
  error del lote: ese par hay que revisarlo a mano, y no se fuerza.
- En un gol en contra, API-Football no aclara si el evento trae el equipo del autor o el
  beneficiado: se prueba contra el marcador, y si ambas lecturas cierran con atribuciones
  distintas la cronología queda `incomplete`.
- Tras una tanda de penales el marcador no se compara (los proveedores no coinciden en incluirla).
- Solo se aceptan partidos terminados en ambos sistemas.

## Estado de la validación (honesto)

Lo verificado por código y pruebas automáticas: normalización, vinculación, idempotencia,
conservación ante respuestas incompletas, cuota/reintentos, contrato de la API y renderizado.
La migración se aplicó y probó contra un PostgreSQL local (atomicidad, unicidad, permisos y
repetición sin duplicados).

**Pendiente** (requiere la cuenta de API-Football y la base del entorno objetivo, que no estaban
disponibles al implementar): la comprobación inicial con **al menos tres partidos terminados de
2024** (Eurocopa y/o Premier League), la evidencia saneada de cobertura por partido, el consumo de
cuota real y los enlaces de ejecución `dry_run=true` y `dry_run=false`. Si la cobertura real falta,
se registra como bloqueo para Francisco antes de ampliar alcance o cambiar de fuente.

### Plantilla de evidencia saneada (por partido)

| Campo                            | Valor                                                   |
| -------------------------------- | ------------------------------------------------------- |
| `MATCH_ID` / `FIXTURE_ID`        |                                                         |
| Equipos (interno ↔ proveedor)    |                                                         |
| Competición / temporada (API)    |                                                         |
| Inicio UTC (interno ↔ proveedor) |                                                         |
| Estadísticas: cobertura y campos | presentes / ausentes                                    |
| Goles: cobertura y conciliación  | cantidad y resultado de la conciliación con el marcador |
| Cuota consumida                  | pedidos de la corrida / reservados hoy                  |

Sin URLs de base de datos, claves ni cabeceras con credenciales.
