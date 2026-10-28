# Estadísticas de partido en football-data.org (plan Free) — relevamiento

## Resumen

Se consultó, con la cuenta y el proveedor que usa hoy el proyecto (football-data.org, plan
Free, Premier League), si el proveedor entrega estadísticas reales de partido. **No las entrega:**
ninguna de las cinco métricas pedidas llega en la respuesta de esta cuenta. Según la página de
planes del proveedor, las estadísticas por partido forman parte de un complemento de pago
(_Statistic Add-On_), que no está contratado. Por eso el acceso se registra como **restringido**
para las cinco. No se contrató ningún servicio y ningún dato ausente se usó como cero.

## Consulta realizada

- **Fecha de la consulta**: 2026-10-28, 15:29 UTC.
- **Proveedor y cuenta**: football-data.org, la cuenta Free configurada en el backend
  (`FOOTBALL_DATA_ORG_API_KEY`, proveedor por defecto de `matches:sync`).
- **Competición**: Premier League (código `PL`), temporada 2026, la misma que usa la aplicación.
- **Pedidos** (5 en total, todos con respuesta `200`):
  1. `GET /v4/competitions/PL/matches?status=FINISHED&dateFrom=2026-10-24&dateTo=2026-10-27`:
     9 partidos terminados.
  2. `GET /v4/matches/560614` (Aston Villa FC vs Manchester City FC, `FINISHED`).
  3. `GET /v4/matches/560616` (Arsenal FC vs Everton FC, `FINISHED`).
  4. Los pedidos 2 y 1 de nuevo, con una búsqueda profunda de claves (ver más abajo).
- **Límite observado**: tras el primer pedido quedaban 9 por minuto, y 7 tras el tercero, con un
  reinicio cercano a 60 s. Es consistente con los 10 pedidos por minuto del plan Free.

## Acceso por métrica

| Métrica       | Campo del proveedor | Lo observado en esta cuenta | Acceso          |
| ------------- | ------------------- | --------------------------- | --------------- |
| Posesión      | `ball_possession`   | Ausente en ambos partidos   | **Restringido** |
| Remates       | `shots`             | Ausente en ambos partidos   | **Restringido** |
| Tiros al arco | `shots_on_goal`     | Ausente en ambos partidos   | **Restringido** |
| Córners       | `corner_kicks`      | Ausente en ambos partidos   | **Restringido** |
| Faltas        | `fouls`             | Ausente en ambos partidos   | **Restringido** |

«Restringido» significa que el proveedor sí ofrece el dato, pero no con el plan actual. «Ausente»
significaría que el proveedor no lo ofrece en absoluto, y no es el caso.

## Evidencia sanitizada

La respuesta del detalle de un partido terminado no trae el bloque de estadísticas. Estas son las
claves reales de la respuesta de `GET /v4/matches/560614` (la de `560616` es idéntica):

```json
{
  "status": 200,
  "estado_proveedor": "FINISHED",
  "claves_respuesta": [
    "area",
    "awayTeam",
    "competition",
    "group",
    "homeTeam",
    "id",
    "lastUpdated",
    "matchday",
    "odds",
    "referees",
    "score",
    "season",
    "stage",
    "status",
    "utcDate",
    "venue"
  ],
  "claves_homeTeam": ["crest", "id", "name", "shortName", "tla"]
}
```

- Ni `homeTeam` ni `awayTeam` incluyen `statistics`.
- Una búsqueda profunda en toda la respuesta, del detalle y del listado, de cualquier clave que
  contenga `possess`, `shot`, `corner`, `foul`, `statist`, `offside`, `card` o `save` no devolvió
  ninguna coincidencia: el dato no llega con otro nombre ni en otro nivel.
- La respuesta es `200` y no un `403`: la cuenta no recibe un error, simplemente no recibe el
  bloque. Por eso no se puede distinguir «restringido» de «ausente» solo mirando la respuesta; se
  distingue con la documentación del proveedor.

## Qué dice el proveedor

- La documentación del recurso `Match` (`docs.football-data.org/general/v4/match.html`) define un
  bloque `statistics` en cada equipo con estos campos: `corner_kicks`, `free_kicks`, `goal_kicks`,
  `offsides`, `fouls`, `ball_possession`, `saves`, `throw_ins`, `shots`, `shots_on_goal`,
  `shots_off_goal`, `yellow_cards`, `yellow_red_cards` y `red_cards`.
- Esa página no dice qué plan los incluye. La página de planes (`football-data.org/pricing`,
  consultada el mismo día) los lista en el **Statistic Add-On** (EUR 15 por mes), que «solo puede
  contratarse sobre un plan regular». El plan Free no los incluye.
- Los planes con más datos (por ejemplo _Free + Deep Data_, con alineaciones, goleadores y
  tarjetas) no listan estas métricas: en la página de planes figuran solo en el complemento.

## Cómo tratar el dato ausente

- La aplicación hoy no consume ni guarda ninguna de estas métricas: no aparecen en el código,
  en el esquema ni en los documentos.
- Si un ticket futuro las incorporara, un partido sin bloque `statistics` debe guardarse y
  mostrarse como **sin dato**, nunca como `0`. Una posesión de `0` o `0` córners son valores
  reales y distintos de la falta de dato.
- Contratar el complemento es una decisión de costo y de cuenta, fuera de este relevamiento.

## Alcance y límites

- Se consultó únicamente el proveedor actual. API-Football no se consultó: no es el proveedor por
  defecto y su plan Free ya se documentó sin cobertura de la temporada vigente
  (`docs/integrations/api-football-coverage.md`).
- El plan se infiere de la documentación del proveedor y de lo observado, no de un campo de la
  respuesta: la consulta no devolvió el nivel de la cuenta.
- La verificación es puntual (dos partidos terminados de una fecha). Un partido en vivo o de otra
  fecha no se probó, pero la restricción es del plan y no del partido.
- No se importaron ni persistieron datos, no se agregó código a la aplicación y no se contrató
  ningún servicio.
