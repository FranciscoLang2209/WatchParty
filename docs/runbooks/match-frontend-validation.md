# Runbook: validación del recorrido de partidos (web)

Comprueba el recorrido autenticado **Home → detalle de partido** y sus regresiones, con dos
caminos separados: los estados alternativos por mocks/local y una única pasada integrada
contra el stack local.

No agrega infraestructura E2E (Playwright, Cypress), no introduce un proveedor deportivo ni
duplica en tests lo que ya cubren las pantallas. El camino integrado reutiliza un partido ya
servido por el backend: **no dispara ninguna importación ni consulta nueva a API-Football**.

## SHA validado

| Dato          | Valor                                                   |
| ------------- | ------------------------------------------------------- |
| SHA integrado | `e7baa530768f43edcb97042b1856dbc0396ebc66` (`main`)     |
| Contenido     | merge de la PR #24 (WAT-93, detalle mínimo del partido) |
| Fecha         | 2026-09-06                                              |
| Entorno       | Node 24.19.0, pnpm 10.34.0, macOS                       |

## Comandos y resultado

Ejecutados desde la raíz del repo, sobre el SHA de arriba:

| Comando                       | Resultado                                                      |
| ----------------------------- | -------------------------------------------------------------- |
| `pnpm --filter web lint`      | OK, sin hallazgos                                              |
| `pnpm --filter web typecheck` | OK                                                             |
| `pnpm --filter web test`      | OK — 13 archivos, 155 tests                                    |
| `pnpm --filter web build`     | OK — `dist/assets/index-*.js` 549.76 kB (163.50 kB gzip)       |
| `pnpm validate` (raíz)        | OK — formato, lint, typecheck, tests (api 24 / web 155), build |

El build emite la advertencia de Vite «Some chunks are larger than 500 kB»: es informativa y
no rompe el comando.

## Los dos caminos

### Camino A — mocks/local

No necesita Docker, Supabase ni la API: `fetch` y Supabase Auth están mockeados en los tests.

```sh
pnpm --filter web test
```

Es el único camino que se usa para los estados alternativos (lista vacía, red caída, 500,
401, 404): forzarlos contra el stack real exigiría romper el backend a mano.

### Camino B — integrado (stack local)

Precondiciones:

1. Docker Desktop en ejecución.
2. `pnpm supabase:start` desde la raíz.
3. `apps/api/.env` con `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `WEB_ORIGIN=http://localhost:5173`.
4. `apps/web/.env` (copia de `.env.example`) apuntando a Supabase local y a
   `VITE_API_BASE_URL=http://127.0.0.1:3000`.
5. API arriba (ver [Hallazgos](#hallazgos) si `dev` falla) y `pnpm --filter web dev` en `:5173`.

Con eso, el usuario se registra o inicia sesión en la web y la Home pide `GET /matches` con el
bearer de esa sesión. Ningún dato sale de Supabase: la sesión sólo aporta el token.

## Matriz de escenarios

| #   | Escenario                          | Camino A (mocks/local)                                                                            | Camino B (integrado)                             | Resultado esperado                                                         | Estado                |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- | --------------------- |
| 1   | Login con credenciales válidas     | `auth.test.tsx`: restaura sesión y habilita la ruta privada                                       | Formulario `/login` contra Supabase local        | Entra a `/` sin recargar la página                                         | A: OK · B: pendiente  |
| 2   | Registro de una cuenta nueva       | `features/auth/auth.test.tsx`                                                                     | Formulario `/register` contra Supabase local     | Queda con sesión y entra a `/`                                             | A: OK · B: pendiente  |
| 3   | Home manda el bearer a la Node API | `home.test.tsx`: «consulta únicamente la Node API, con bearer» y «no consulta tablas de Supabase» | `GET /matches` con token real → 200              | Una sola llamada, con `Authorization: Bearer …`; cero consultas a Supabase | A: OK · B: OK         |
| 4   | Listado con partidos               | `home.test.tsx`: una tarjeta por partido, en lista semántica                                      | 3 partidos del catálogo local (`match-001..003`) | Una tarjeta por partido, orden por fecha                                   | A: OK · B: OK (datos) |
| 5   | Listado vacío                      | `home.test.tsx`: «explica la lista vacía en vez de dejar la pantalla en blanco»                   | —                                                | Texto «Todavía no hay partidos disponibles», sin error                     | A: OK                 |
| 6   | Red caída / 500 y reintento        | `home.test.tsx` y `match-detail.test.tsx`: red, 500 y «el reintento vuelve a consultar»           | —                                                | Mensaje de error + botón «Reintentar»; nunca «no hay partidos»             | A: OK                 |
| 7   | Sesión vencida (401)               | `home.test.tsx` / `match-detail.test.tsx`: «ofrece reingresar con el flujo de Auth existente»     | `GET /matches` sin token → 401 `UNAUTHORIZED`    | «La sesión venció» + botón que reingresa por Auth                          | A: OK · B: OK         |
| 8   | Tarjeta → detalle                  | `match-card.test.tsx`: enlaza a `/matches/:id` preservando el id opaco                            | Click en «Ver partido» de `match-001`            | Navega dentro de la SPA al detalle correcto                                | A: OK · B: pendiente  |
| 9   | Detalle por URL directa            | `match-detail.test.tsx`: «abre por URL directa y muestra el contenido aprobado»                   | `GET /matches/match-001` con token → 200         | Equipos, horario y estado; sin sala, chat ni marcador                      | A: OK · B: OK         |
| 10  | Partido inexistente (404)          | `match-detail.test.tsx`: «un 404 se comunica como partido inexistente»                            | `GET /matches/no-existe` → 404 `NOT_FOUND`       | «No encontramos ese partido», no un error genérico                         | A: OK · B: OK         |
| 11  | Ausencia de sesión                 | `router.test.tsx`: Home y detalle redirigen a `/login`                                            | Abrir `/` y `/matches/match-001` sin sesión      | Redirección a `/login`, sin parpadeo de contenido privado                  | A: OK · B: pendiente  |
| 12  | Volver a Home desde el detalle     | `match-detail.test.tsx`: «"Volver a Home" navega a / dentro de la SPA»                            | Enlace «Volver a Home»                           | Vuelve a `/` sin recarga completa                                          | A: OK · B: pendiente  |

Las filas marcadas «B: pendiente» dependen de una pasada visual en el navegador; el resto del
camino integrado quedó comprobado con peticiones reales (ver abajo).

### Evidencia del camino integrado

Sobre el stack local, con un usuario temporal creado en el momento (sin credenciales
versionadas) y `Origin: http://localhost:5173`:

| Chequeo                                  | Esperado | Obtenido                                                  |
| ---------------------------------------- | -------- | --------------------------------------------------------- |
| Preflight `OPTIONS /matches`             | 204      | 204, `Access-Control-Allow-Origin: http://localhost:5173` |
| `GET /matches` con bearer real           | 200      | 200, 3 partidos                                           |
| `GET /matches/match-001` con bearer real | 200      | 200, `River Plate` vs. `Boca Juniors`                     |
| `GET /matches/no-existe` con bearer real | 404      | 404, `{"error":{"code":"NOT_FOUND"}}`                     |
| `GET /matches` sin token                 | 401      | 401, `{"error":{"code":"UNAUTHORIZED"}}`                  |

El mismo recorrido, extremo a extremo y sin mocks, lo automatiza el smoke del backend:

```sh
pnpm --filter @watchparty/api smoke:auth-matches   # 4/4 chequeos OK
```

## Matriz responsive y accesibilidad

Pasada manual sobre `/` y `/matches/match-001`, en claro y oscuro (el interruptor vive en el
Header). Referencias del layout: la navegación inferior es `fixed` y desaparece desde 981 px
(`--breakpoint-desktop`); `main` reserva su alto con `pb-bottom-nav`.

| Ancho   | Qué mirar                                                                           | Estado    |
| ------- | ----------------------------------------------------------------------------------- | --------- |
| 320 px  | Sin scroll horizontal; la BottomNavigation no tapa «Ver partido» ni «Volver a Home» | pendiente |
| 390 px  | Igual que 320, con los 4 destinos de la barra legibles                              | pendiente |
| 768 px  | Tarjetas a ancho completo dentro de `max-w-3xl`; barra inferior todavía visible     | pendiente |
| 1024 px | Barra inferior visible hasta 980 px; contenido centrado                             | pendiente |
| 1280 px | Sin barra inferior: la navegación vive en el Header                                 | pendiente |
| 1440 px | Sin recortes ni columnas vacías; el `h1` del detalle no desborda                    | pendiente |

Además, en cada pasada:

- **Nombres largos:** un partido con equipos de nombre extenso no genera scroll horizontal
  (`min-w-0` + `break-words` en la tarjeta y en el `h1` del detalle). Cubierto en mocks por
  `match-card.test.tsx`: «un nombre largo no fuerza desplazamiento horizontal».
- **Teclado y foco:** recorrer con `Tab` desde el Header hasta «Ver partido» y volver; el
  anillo de foco (`focus-visible:ring-2`) debe verse en enlaces y botones, y el orden debe
  seguir el orden visual.
- **`aria-live`:** «Cargando partidos…», «Cargando el partido…» y «No encontramos ese partido»
  usan `role="status"`; los errores usan `role="alert"`. Con un lector de pantalla, cada
  cambio de estado se anuncia una sola vez.
- **Sin contenido cubierto:** al final de la página, el último elemento interactivo queda por
  encima de la BottomNavigation.

Cómo completarla: `pnpm --filter web dev`, y en el navegador ajustar el ancho de la ventana (o
el modo dispositivo de DevTools) a cada valor de la tabla, alternando el tema en el Header.

## Checklist de cierre

- [x] Los cuatro comandos de web y `pnpm validate` pasan sobre el SHA registrado.
- [x] Los estados alternativos (vacío, red, 500, 401, 404) se prueban por mocks/local.
- [x] El camino integrado reutiliza un partido existente del catálogo del backend; no dispara
      importaciones ni consultas al proveedor.
- [x] Ni el runbook ni la evidencia incluyen claves, tokens ni credenciales.
- [ ] Matriz responsive (320 → 1440 px, claro/oscuro) sin recorte, overflow, foco ausente ni
      contenido cubierto.
- [ ] Capturas de Home y detalle adjuntas a la PR.

## Hallazgos

1. **`pnpm --filter @watchparty/api dev` no arranca.** El script es
   `tsx --env-file-if-exists=.env watch src/server.ts`: `tsx` interpreta `watch` como el
   módulo a ejecutar y falla con `ERR_MODULE_NOT_FOUND … /apps/api/watch`. El subcomando va
   antes de los flags (`tsx watch --env-file-if-exists=.env src/server.ts`). Fuera del alcance
   de este ticket; mientras tanto, la API se levanta con:

   ```sh
   pnpm --filter @watchparty/api exec tsx --env-file-if-exists=.env src/server.ts
   ```

2. **Bundle de web sobre 500 kB.** El build avisa por el chunk único de 549.76 kB
   (163.50 kB gzip). Hoy no bloquea nada; si molesta, se resuelve con code-splitting.
