# Runbook: validación del historial y de los agregados de KPIs (WAT-223)

Verifica el frente de Martina del plan 15–22/10/2026: el historial propio de partidos vistos (WAT-217/218/219) y los agregados de negocio `rated_match_rate` y `monthly_interactions_avg` (WAT-220/221/222). Los datos sintéticos se crean solo en el entorno local; nada de esto se corre contra producción.

## SHA validado

| Dato      | Valor                                                                     |
| --------- | ------------------------------------------------------------------------- |
| SHA       | `d2f752efdc7f429ff3b84c7a40dce6327195fb4a` (`main`)                       |
| Contenido | merge de la PR #113 (WAT-222), con WAT-217 a WAT-222 y WAT-230 integrados |
| Fecha     | 2026-10-22                                                                |
| Entorno   | Node 24.19.0, pnpm 10.34.0, macOS, Supabase local (Postgres 17.6)         |

## 1. Historial: recorrido integrado contra la API local

Precondiciones: Supabase local levantado con las migraciones aplicadas y la API en `:3000` (`pnpm --filter @watchparty/api dev`).

```sh
pnpm --filter @watchparty/api verify:watched-history-journey
```

Crea dos usuarios temporales y sus propios 3 partidos (con service_role, como el backend), los marca por la API y recorre `GET /me/watched-matches` con páginas de 2 para tener varias páginas. No depende del seed ni de la ventana de agenda de `GET /matches`, así que funciona igual en una base recién inicializada. Al terminar borra los partidos, los equipos y los vistos que creó.

| Chequeo                                                               | Resultado |
| --------------------------------------------------------------------- | --------- |
| Sin sesión, el historial responde 401                                 | OK        |
| Usuario sin vistos: historial vacío y sin página siguiente            | OK        |
| Orden del más reciente al más antiguo                                 | OK        |
| Paginación de a 2: varias páginas sin duplicados ni faltantes         | OK        |
| `watchedAt` no crece entre un item y el siguiente                     | OK        |
| Cada item navega a un detalle existente (`GET /matches/:id` 200)      | OK        |
| Otro usuario solo ve lo propio                                        | OK        |
| Lo que marca otro usuario no aparece ni altera el historial propio    | OK        |
| El historial persiste en una sesión nueva del mismo usuario           | OK        |
| Deshacer un visto lo quita del historial (visto desde la otra sesión) | OK        |
| Un tamaño de página inválido responde 400                             | OK        |

## 2. Historial: pasada manual en la web local

Web en `http://localhost:5173` contra la API y el Supabase locales, con dos cuentas de prueba locales. Ejecutada por Martina el 2026-10-22.

| #   | Paso                                                        | Esperado                                                                                     | Resultado |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------- |
| 1   | Marcar 2–3 partidos y abrir el Perfil                       | Historial con el último marcado arriba, equipos, fecha y resultado; la edición sigue estando | OK        |
| 2   | Recargar                                                    | Mismo historial, mismo orden                                                                 | OK        |
| 3   | Clic en un partido del historial y volver                   | Abre el detalle de ese partido; al volver el historial sigue bien                            | OK        |
| 4   | Cerrar sesión y volver a entrar con la misma cuenta         | Mismo historial                                                                              | OK        |
| 5   | Entrar con otra cuenta                                      | Historial vacío con su mensaje; no aparecen partidos de la primera cuenta                    | OK        |
| 6   | Con la segunda cuenta marcar 1 partido; volver a la primera | Cada cuenta ve solo lo propio                                                                | OK        |
| 7   | Recorrer el perfil con Tab y Enter                          | Se llega a cada partido, el foco es visible y Enter abre el detalle                          | OK        |
| 8   | Modo celular a 320 px                                       | Sin scroll horizontal; la barra inferior no tapa el historial                                | OK        |
| 9   | Desmarcar un partido y volver al Perfil                     | El partido desaparece del historial                                                          | OK        |

"Cargar más" no se ve en esta pasada: aparece con más de 20 vistos y en local hay 3 partidos. La paginación queda cubierta por el chequeo de la sección 1 (páginas de 2) y por los tests de la web.

## 3. Agregados de negocio contra un conjunto conocido

```sh
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @watchparty/api verify:rated-match-rate
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @watchparty/api verify:monthly-interactions-avg
```

Ambos siembran datos sintéticos en marzo de 2020 dentro de una transacción que se revierte, y solo aceptan un host local. Detalle de los conjuntos en [reporter-rated-match-rate.md](reporter-rated-match-rate.md) y [reporter-monthly-interactions-avg.md](reporter-monthly-interactions-avg.md).

| Caso                                                                                  | `rated_match_rate`       | `monthly_interactions_avg`        |
| ------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- |
| Cálculo conocido, con cuenta técnica excluida                                         | 40 % (2/5) — OK          | 4/3 — OK                          |
| Misma base sin marcar la cuenta técnica                                               | 50 % (3/6) — OK          | 1.25 (5/4) — OK                   |
| Límite del mes argentino (00:30 del 1/03 dentro; 23:30 del 29/02 fuera) y del corte T | OK                       | OK                                |
| Varios comentarios y nota del mismo par                                               | Cuenta una vez — OK      | Cada registro suma — OK           |
| Nota editada en el mes / reacción                                                     | La edición califica — OK | Ni edición ni reacción suman — OK |
| Usuario activo solo por visto                                                         | —                        | Promedio 0 válido — OK            |
| Mes sin datos                                                                         | `no-denominator` — OK    | `no-denominator` — OK             |
| Corte T futuro                                                                        | `invalid-cutoff` — OK    | `invalid-cutoff` — OK             |
| `anon` / `authenticated` sin `EXECUTE`                                                | OK                       | OK                                |
| Rol con solo `USAGE` + `EXECUTE`: obtiene el agregado y recibe `42501` en las tablas  | OK                       | OK                                |

## 4. Tests automatizados

| Comando                                                                                   | Resultado                   |
| ----------------------------------------------------------------------------------------- | --------------------------- |
| `pnpm --filter web exec vitest run src/features/watched src/features/profiles`            | OK — 6 archivos, 147 tests  |
| `pnpm --filter @watchparty/api exec vitest run src/modules/watched src/modules/reporting` | OK — 13 archivos, 510 tests |
| `pnpm --filter @watchparty/api test`                                                      | OK — 1031 tests             |

## Producción

Las migraciones de WAT-220 y WAT-221 se aplicaron el 2026-10-22 y se verificaron con consultas de solo lectura: el esquema `reporting` sigue siendo de `watchparty_reporter_source`; `watchparty_reporter` tiene `USAGE` + `EXECUTE` sobre ambos agregados y no tiene `SELECT` sobre `technical_accounts` ni `watched_matches`; `anon` y `authenticated` no tienen `EXECUTE`. Con el corte de ese momento, `rated_match_rate` devolvió `no-denominator` (sin vistos en el mes) y `monthly_interactions_avg` devolvió 4.

Pendiente fuera de este ticket: la lectura con la credencial del reporter (`reporter:verify-business`, WAT-222) y cargar en `reporting.technical_accounts` las cuentas técnicas reales de producción, hoy vacía.
