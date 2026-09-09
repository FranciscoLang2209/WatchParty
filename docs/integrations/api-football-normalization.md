# Normalización de fixtures de API-Football

Este documento define cómo se traduce el estado de un fixture de API-Football al
estado interno de `NormalizedSportsFixture`, y qué se hace con los que no encajan.

## Tabla de estados

| Estado API-Football                             | Estado interno | Acción                                |
| ----------------------------------------------- | -------------- | ------------------------------------- |
| `NS`, `TBD`                                     | `scheduled`    | Normalizar si fecha e IDs son válidos |
| `1H`, `HT`, `2H`, `ET`, `BT`, `P`, `LIVE`       | `live`         | Normalizar si fecha e IDs son válidos |
| `FT`, `AET`, `PEN`                              | `finished`     | Normalizar si fecha e IDs son válidos |
| `PST`                                           | `postponed`    | Normalizar si fecha e IDs son válidos |
| `CANC`                                          | `cancelled`    | Normalizar si fecha e IDs son válidos |
| `SUSP`, `INT`, `ABD`, `AWD`, `WO` o desconocido | —              | Omitir con motivo                     |

## Reglas que nunca se aplican

- Convertir un estado desconocido a `scheduled`.
- Equiparar suspendido, interrumpido, abandonado o walkover con aplazado o cancelado.
- Reemplazar una fecha inválida por la fecha actual.

## Implementación

La tabla está codificada en `STATUS_MAP` dentro de
`apps/api/src/modules/matches/application/api-football-normalizer.ts`. Cualquier
código de estado que no sea una clave de ese mapa (incluidos `SUSP`, `INT`, `ABD`,
`AWD`, `WO`, y cualquier código futuro no contemplado) se omite con el motivo
`unrepresentable-status`, sin excepciones ni valores por defecto.

Un fixture con fecha inválida se omite con el motivo `invalid-kickoff-date` — nunca
se sustituye por `new Date()` ni ninguna otra fecha.
