# Cobertura de API-Football (plan Free) — WAT-100

## Resumen

Se verificó, con una cuenta Free real de API-Football, qué competición argentina y
qué temporada permite consultar el endpoint `fixtures`. La temporada vigente (2026)
**no está disponible** en el plan Free; se documenta una temporada histórica apta.

## Consulta realizada

- **Fecha de la consulta**: 2026-09-07
- **Competición**: Liga Profesional Argentina (ID externo `128`)
- **Temporada verificada**: 2023
- **Rango de fechas consultado**: `2023-03-01` a `2023-03-14`
- **Parámetros aprobados**: `league`, `season`, `from`, `to`
- **Resultados**: 28 fixtures
- **Paginación**: 1 página (`paging.total: 1`)

## Bloqueo encontrado y resolución

Una primera consulta a la temporada vigente (`season=2026`) fue rechazada por el
plan con este mensaje explícito del proveedor:

> `"Free plans do not have access to this season, try from 2022 to 2024."`

Por lo tanto, **no se puede usar la temporada actual** con el plan Free. Se repitió
la consulta con `season=2023` (dentro del rango permitido), que sí devolvió
resultados válidos y no vacíos.

## Fixture representativo (sanitizado)

```json
{
  "fixture": { "id": 971418, "date": "2023-03-03T23:00:00+00:00", "status": { "short": "FT" } },
  "league": { "id": 128, "name": "Liga Profesional Argentina", "season": 2023 },
  "teams": {
    "home": { "id": 441, "name": "Union Santa Fe" },
    "away": { "id": 450, "name": "Estudiantes L.P." }
  }
}
```

## Límites observados

| Métrica                                        | Valor observado |
| ---------------------------------------------- | --------------- |
| Límite diario                                  | 100             |
| Restante diario (tras la consulta exitosa)     | 97              |
| Límite por minuto                              | 10              |
| Restante por minuto (tras la consulta exitosa) | 9               |

La consulta rechazada por plan (`season=2026`) no devolvió headers de rate-limit —
no disponible para ese caso puntual.

## Advertencia sobre la cuota

Estos valores reflejan lo observado en esta sesión de verificación puntual. La
aplicación va a usar un presupuesto propio compartido, definido en un ticket
posterior — **no se controla la cuota global de la cuenta**, ya que el proveedor
también puede considerar el usuario/API y la IP de salida al calcularla.

## Fuera de alcance de esta verificación

No se importaron ni persistieron datos, no se crearon endpoints, cron, workers ni
colas, y no se consultó API-Football desde ninguna ruta HTTP de la aplicación.
