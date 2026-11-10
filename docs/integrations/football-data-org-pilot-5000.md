# Piloto de importación por lotes de football-data.org — camino a 5.000 partidos

## Objetivo

Probar cuántos partidos reales puede importar WatchParty desde football-data.org (plan Free) para
el Tercer Steering, y estimar el camino a 5.000 partidos históricos. El sincronizador diario
(`matches:sync`, Premier League 2026 con ventana móvil) no cambia.

## Cómo se corre

Comando nuevo, `matches:import-batch`. Reutiliza el cliente de football-data.org, la normalización
y el mismo motor que la sincronización diaria: lease por competición y temporada, cuota diaria
persistente, límite por minuto, reintento y `upsert_match_fixture` idempotente. La diferencia es
que pide la **temporada completa** (sin `dateFrom`/`dateTo`), con la competición y la temporada
que se pasan en la consulta.

```sh
# Lote del piloto (por defecto): CL:2025,WC:2026,EC:2024,PL:2025,PD:2025
pnpm --filter @watchparty/api matches:import-batch

# Otro lote: CODIGO:AÑO separado por comas (año de inicio de la temporada)
MATCHES_IMPORT_BATCH="BL1:2025,SA:2025" pnpm --filter @watchparty/api matches:import-batch
```

En demo se dispara con el workflow manual **Matches import batch** (Actions → Run workflow). El
input `batch` acepta el mismo formato, y si se deja vacío corre el lote del piloto. Comparte el grupo de
concurrencia con `Matches sync`, así que nunca corre al mismo tiempo que la sincronización diaria.

- El lote se ordena Champions → selecciones → ligas, por si la cuota obliga a cortar.
- Solo acepta las 12 competiciones del plan Free (`PL`, `PD`, `CL`, `WC`, `EC`, `ELC`, `PPL`,
  `BL1`, `SA`, `FL1`, `DED`, `BSA`). Un código fuera del plan, un año inválido o una entrada
  repetida terminan con código 2 sin consultar al proveedor.
- Si el proveedor rechaza una entrada (p. ej. `403` por el plan), queda registrada con su mensaje
  y el lote sigue con la siguiente. El comando sale con 1 si alguna entrada falló.
- Imprime el reporte en JSON y una tabla Markdown por competición y temporada con los pedidos,
  el status HTTP, los partidos devueltos, guardados y nuevos, y cuántos están finalizados con
  marcador.
- Cada entrada consume un pedido de la cuota diaria propia de `football-data-org` (80 por día),
  la misma que usa la sincronización diaria.

## Acceso verificado (2026-11-10)

Consultas de solo lectura a `GET /v4/competitions/:code/matches?season=:año` con la cuenta Free del
equipo:

| Competición      | Código | Temporada | HTTP    | Partidos | Finalizados con marcador |
| ---------------- | ------ | --------- | ------- | -------- | ------------------------ |
| Champions League | `CL`   | 2025      | 200     | 189      | 189                      |
| Mundial          | `WC`   | 2026      | 200     | 104      | 104                      |
| Eurocopa         | `EC`   | 2024      | 200     | 51       | 51                       |
| Premier League   | `PL`   | 2025      | 200     | 380      | 380                      |
| La Liga          | `PD`   | 2025      | 200     | 380      | 380                      |
| Premier League   | `PL`   | 2024      | 200     | 380      | 380                      |
| Premier League   | `PL`   | 2023      | 200     | 380      | 380                      |
| Premier League   | `PL`   | 2022      | **403** | —        | —                        |
| Champions League | `CL`   | 2024      | 200     | 189      | 189                      |
| Bundesliga       | `BL1`  | 2025      | 200     | 306      | 306                      |
| Serie A          | `SA`   | 2025      | 200     | 380      | 380                      |
| Ligue 1          | `FL1`  | 2025      | 200     | 306      | 305                      |
| Eredivisie       | `DED`  | 2025      | 200     | 306      | 306                      |
| Primeira Liga    | `PPL`  | 2025      | 200     | 306      | 306                      |
| Championship     | `ELC`  | 2025      | 200     | 557      | 557                      |
| Brasileirão      | `BSA`  | 2025      | 200     | 380      | 380                      |

El rechazo de `PL 2022` dice: _"The resource you are looking for is restricted and apparently not
within your permissions. Please check your subscription."_ El plan Free cubre la temporada vigente y
las dos anteriores; antes de eso, `403`. Los dos torneos de selecciones pedidos (Mundial 2026 y
Eurocopa 2024) son accesibles.

## Corrida del piloto

### Local (Supabase local, 2026-11-10)

Primera corrida del lote del piloto:

| Competición | Temporada | Pedidos | HTTP | Devueltos | Guardados | Nuevos | Finalizados con marcador | Resultado |
| ----------- | --------- | ------- | ---- | --------- | --------- | ------ | ------------------------ | --------- |
| CL          | 2025      | 1       | 200  | 189       | 189       | 189    | 189                      | ok        |
| WC          | 2026      | 1       | 200  | 104       | 104       | 104    | 104                      | ok        |
| EC          | 2024      | 1       | 200  | 51        | 51        | 51     | 51                       | ok        |
| PL          | 2025      | 1       | 200  | 380       | 380       | 380    | 380                      | ok        |
| PD          | 2025      | 1       | 200  | 380       | 380       | 380    | 380                      | ok        |
| **Total**   |           | 5       |      | 1104      | 1104      | 1104   | 1104                     |           |

Segunda corrida del mismo lote: los mismos 1.104 partidos guardados, **0 nuevos**. Conteo en
`matches` antes y después de repetir, por `competition_external_id`: `2001` 189, `2000` 104,
`2018` 51, `2021` 380 y `2014` 380, sin cambios. Repetir el lote no agrega duplicados.

Búsqueda y detalle (`GET /matches/search` y `GET /matches/:id`, con usuario autenticado):

- `q=Spain`: 15 resultados. Detalle de España 3–0 Croacia (Eurocopa, 2024-06-15), `finished`.
- `q=Argentina`: 8 resultados. Detalle de Argentina 3–0 Argelia (Mundial, 2026-06-17),
  `finished`.
- `q=Real Madrid`: 20 resultados (La Liga y Champions).

### Demo

Pendiente: se corre con el workflow **Matches import batch** una vez mergeado, y la tabla que
imprime se pega acá junto con un partido de Champions y uno de selecciones vistos en la búsqueda
o el detalle de demo.

## Hallazgo: marcador con definición por penales

En los partidos que se definen por penales, `score.fullTime` de football-data.org **suma los goles
de la tanda**. La final de Champions 2025/26 llega como PSG 5–4 Arsenal: 1–1 en el partido, 0–0 en
la prórroga y 4–3 en penales. El detalle está en `regularTime`, `extraTime` y `penalties`, junto a
`duration: "PENALTY_SHOOTOUT"`.

En el piloto afecta a 8 de 1.104 partidos: 1 de Champions, 4 del Mundial y 3 de la Eurocopa. Las
ligas no tienen penales. La normalización actual guarda `fullTime` tal cual, así que esos 8
partidos muestran el marcador con penales incluidos. Corregirlo (p. ej. usar `regularTime` +
`extraTime` cuando `duration` es `PENALTY_SHOOTOUT`) queda para otro ticket. Este piloto no cambia
la normalización.

## Camino a 5.000 partidos

El piloto aporta 1.104 partidos con 5 pedidos. Cada competición y temporada es **un solo pedido**,
así que la cuota no es el límite: se llega a 5.000 con unos 17 pedidos en total, muy por debajo
del presupuesto propio de 80 por día. El límite por minuto (10) lo respeta el propio comando.

| Lote            | Entradas                                                        | Partidos | Acumulado |
| --------------- | --------------------------------------------------------------- | -------- | --------- |
| 1 (piloto)      | `CL:2025,WC:2026,EC:2024,PL:2025,PD:2025`                       | 1.104    | 1.104     |
| 2 (ligas 25/26) | `BL1:2025,SA:2025,FL1:2025,DED:2025,PPL:2025,ELC:2025,BSA:2025` | 2.541    | 3.645     |
| 3 (24/25)       | `PL:2024,PD:2024,CL:2024,SA:2024,BL1:2024`                      | ~1.635   | ~5.280    |

- Las cifras de los lotes 1 y 2, más `PL:2024` y `CL:2024`, salen de las consultas de arriba.
  `PD`, `SA` y `BL1` 2024 se estiman con el mismo tamaño que en 2025 (20 o 18 equipos).
- La temporada 2023 también está disponible (`PL 2023` respondió 200) como reserva si se quiere
  pasar de 5.000. Antes de 2023 el plan devuelve `403`.
- Como pedía el ticket, Championship (`ELC`) y Primeira Liga (`PPL`) quedan en el lote 2,
  después del piloto.
