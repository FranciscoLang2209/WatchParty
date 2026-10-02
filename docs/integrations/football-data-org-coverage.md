# Cobertura de football-data.org (plan Free) — WAT-180

## Resumen

Se verificó, con una cuenta Free real de football-data.org, el acceso a la Premier League
inglesa. A diferencia de API-Football (`docs/integrations/api-football-coverage.md`), que en su
plan Free **no** cubre la temporada vigente, football-data.org **sí** devuelve la temporada actual
sin restricción.

## Consulta realizada

- **Fecha de la consulta**: 2026-10-01
- **Competición**: Premier League (código `PL`, id interno del proveedor `2021`)
- **Temporada verificada**: 2026 — la vigente (`2026-08-21` a `2027-05-30`)
- **Endpoint usado**: `GET /v4/competitions/PL/matches?status=SCHEDULED`
- **Resultados**: 330 partidos, todos sin jugar (`resultSet.played: 0`)
- **Rango devuelto**: `2026-10-10` (primer partido) a `2027-05-30` (último, final de temporada)

## Partido representativo (sanitizado)

```json
{
  "id": 560593,
  "utcDate": "2026-10-10T11:30:00Z",
  "status": "TIMED",
  "matchday": 6,
  "stage": "REGULAR_SEASON",
  "competition": { "id": 2021, "code": "PL", "name": "Premier League" },
  "homeTeam": { "id": 57, "name": "Arsenal FC", "tla": "ARS" },
  "awayTeam": { "id": 341, "name": "Leeds United FC", "tla": "LEE" }
}
```

## Competiciones incluidas en el plan Free

La cuenta Free da acceso (`plan: TIER_ONE`) a: Premier League (`PL`), Championship (`ELC`), UEFA
Champions League (`CL`), European Championship (`EC`), Ligue 1 (`FL1`), Bundesliga (`BL1`), Serie A
(`SA`), Eredivisie (`DED`), Primeira Liga (`PPL`), La Liga (`PD`), Brasileirão Série A (`BSA`) y FIFA
World Cup (`WC`). La única excepción es Copa Libertadores (`CLI`), marcada `TIER_FOUR` — fuera del
plan Free. No aplica a este ticket (que pide Premier League), pero queda registrado por si se
evalúa otra competición a futuro.

## Vocabulario de estados: diferencia con nuestro dominio

El filtro `status=SCHEDULED` de la API devuelve partidos cuyo campo real `status` dice `"TIMED"`
(horario confirmado, todavía no jugado) — no `"SCHEDULED"`. football-data.org usa su propio
vocabulario (`TIMED`, `IN_PLAY`, `PAUSED`, `FINISHED`, `POSTPONED`, `SUSPENDED`, `CANCELLED`, entre
otros), distinto del `MatchStatus` canónico del dominio
(`apps/api/src/modules/matches/domain/match.ts`: `scheduled | live | finished | postponed |
cancelled`). Quien implemente el cliente (fuera de alcance de este ticket) va a necesitar un mapeo
explícito entre ambos vocabularios, no asumir que coinciden.

## Parámetros verificados

- **Filtro por competición**: por código en el path (`/competitions/PL/matches`), no por id numérico.
- **Filtro `status`**: aceptado y filtra correctamente (aunque con el vocabulario propio del
  proveedor).
- Otros filtros documentados por el proveedor (`dateFrom`, `dateTo`, `season`, `matchday`) no se
  probaron en esta verificación — quedan para cuando se implemente el cliente.

## Límites observados

| Métrica                                                    | Valor observado |
| ---------------------------------------------------------- | --------------- |
| Pedidos restantes en el minuto (tras al menos 2 consultas) | 9               |
| Reinicio del contador (segundos)                           | 39              |

No se obtuvo un límite diario explícito en los headers de esta sesión. El valor remanente por
minuto es consistente con un límite de 10 pedidos/minuto, el que documenta el proveedor para el
plan Free — no confirmado como tope exacto en esta verificación puntual.

## Advertencia sobre la cuota

Estos valores reflejan lo observado en esta sesión de verificación puntual, con una cuenta
personal. La aplicación va a usar un presupuesto propio compartido, a definir en un ticket
posterior — no se controla la cuota global de la cuenta.

## Conclusión

football-data.org, plan Free, da acceso real a la temporada vigente de Premier League. Se
desbloquea lo que el equipo buscaba: cambiar de la liga argentina (sin cobertura de temporada
actual en API-Football) a Premier League con datos actuales y gratuitos.

## Fuera de alcance de esta verificación

No se importaron ni persistieron datos, no se crearon endpoints, cliente, cron, workers ni colas,
y no se consultó football-data.org desde ninguna ruta de la aplicación. El dominio de la
aplicación no debe acoplarse a esta competición puntual.
