# Runbook: carga de 501 usuarios y recorrido de demo (Challenge Sorpresa 2)

Deja el entorno de demo con **al menos 501 cuentas registradas, cada una con su perfil**, dos cuentas
de demostración y una muestra pequeña de actividad coherente, y un guion para ensayar. La carga es
un script versionado, **idempotente y reversible**, que corre del lado servidor con la service_role
key del entorno.

**Estado: el procedimiento está listo y probado con dobles; todavía no se ejecutó contra el entorno
de demo.** Los conteos, el partido elegido y el ensayo de QA se completan al ejecutarlo (ver
«Informe final» y «Guion»).

## Qué hace y qué no

| Hace                                                                                        | No hace                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Crea **solo las cuentas necesarias** para llegar a 501 con perfil, con nombres verosímiles. | No usa el registro público ni baja sus protecciones.                     |
| Crea los perfiles con el mecanismo existente (`SupabaseOwnProfileStore.saveOwnProfile`).    | No manda ningún correo: la Admin API de Auth no envía confirmaciones.    |
| Prepara dos cuentas de demostración que inician sesión por el flujo normal de la app.       | No toca partidos, fechas ni estados, ni vuelve a hacer el backfill.      |
| Siembra una muestra de actividad solo para esas dos cuentas, sobre partidos ya existentes.  | No genera actividad masiva de las 501 cuentas.                           |
| Identifica el lote y permite retirar **solo** lo que creó.                                  | No cambia políticas de acceso, KPIs, tablas ni agrega avatares o videos. |

## Cómo funciona

- **Lote:** cada cuenta que crea lleva `app_metadata.seed_batch = demo-501-v1` (el valor se puede
  cambiar con `DEMO_BATCH_ID`). Es lo único que identifica al lote; `app_metadata` no la puede editar
  la propia persona. La actividad se identifica por su autor: pertenece al lote si su `user_id` es de
  una cuenta del lote.
- **Cuentas:** `auth.admin.createUser` con el correo ya confirmado. Las 499 masivas reciben una
  contraseña aleatoria que **no se guarda ni se muestra**: nadie inicia sesión con ellas. Los correos
  se arman con un nombre y apellido verosímiles más un número (`nombre.apellido.NNN@<dominio>`),
  únicos y estables: la cuenta `n` es siempre la misma persona.
- **Perfiles:** nombre visible, biografía corta y un equipo favorito repartido entre los equipos
  existentes. Un perfil que ya existe no se pisa.
- **Cuántas crea:** `501 − (cuentas con perfil que no son del lote)`, más las dos de demostración
  siempre. Si el entorno ya tiene 490 cuentas con perfil, crea 11.
- **Repetible y recuperable:** una cuenta del lote que ya existe no se vuelve a crear; una cuenta que
  quedó sin perfil por un fallo se completa en la siguiente corrida; un fallo en una cuenta no frena a
  las demás. Un correo que ya pertenece a otra persona **no se toca** y se informa como conflicto.
- **Actividad:** pasa por las mismas tiendas y servicios que usa la API, así que respeta sus reglas.
  Calificar y reseñar exige un partido **finalizado**, visto y, para la reseña, calificado. Los
  comentarios llevan una clave de idempotencia determinista, y las reacciones y el visto son
  idempotentes: repetir no duplica nada. Los textos son opiniones generales que no afirman hechos del
  partido.

## Antes de ejecutar

1. **Acceso:** hace falta la service_role key del entorno de demo (TechLead/dev). Se guarda en
   `apps/api/.env` (ignorado por git) o en el entorno de la terminal. Nunca en el repositorio, en un
   issue ni en un chat.
2. **Identificar el entorno:** anotar el nombre (`DEMO_ENV_LABEL`), la URL de la web de demo
   (`DEMO_WEB_URL`) y **qué base y Auth consume realmente** esa web (variables del proyecto en Vercel).
   El script se niega a correr si `SUPABASE_URL` no coincide con `DEMO_EXPECTED_SUPABASE_HOST`, para
   no cargar sobre la base equivocada.
3. **Restricciones de Auth:** revisar y registrar, antes de correr, si hay un tope de usuarios, reglas
   de contraseña o de dominios de correo en el proyecto. Si Auth rechaza el dominio de los correos,
   cambiarlo con `DEMO_EMAIL_DOMAIN`.
4. **Ver el estado inicial** con `plan` (solo lectura), que muestra los conteos iniciales y los
   partidos terminados más recientes para elegir los de la demo.

### Variables

Solo los nombres; los valores los carga quien ejecuta.

| Variable                                                                       | Para qué                                                                                                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `WEB_ORIGIN` | Las mismas que ya usa la API del entorno elegido.                                                                                 |
| `DEMO_ENV_LABEL`                                                               | Nombre del entorno que sale en el informe (por ejemplo `demo`).                                                                   |
| `DEMO_EXPECTED_SUPABASE_HOST`                                                  | Host que se espera en `SUPABASE_URL`: la guarda contra correr sobre otra base.                                                    |
| `DEMO_WEB_URL`                                                                 | Opcional: URL de la web de demo, para el informe.                                                                                 |
| `DEMO_ACCOUNT_A_EMAIL` / `_PASSWORD`, `DEMO_ACCOUNT_B_EMAIL` / `_PASSWORD`     | Las dos cuentas de demostración. La contraseña, de 12 caracteres o más, la elige quien ejecuta y la entrega por un canal privado. |
| `DEMO_MATCH_IDS`                                                               | Entre 1 y 3 ids de partidos **finalizados** para la actividad. Sin valor, se omite.                                               |
| `DEMO_EMAIL_DOMAIN`, `DEMO_BATCH_ID`, `DEMO_SEED_LIMIT`                        | Opcionales: dominio de los correos, nombre del lote y tope de altas masivas por corrida.                                          |

## Ejecución

Siempre desde la raíz del repositorio:

```sh
# 1. Solo lectura: conteos iniciales, plan y partidos candidatos.
pnpm --filter @watchparty/api demo:seed -- plan

# 2. Prueba acotada: un lote chico, y repetirlo para comprobar que no duplica.
pnpm --filter @watchparty/api demo:seed -- apply --limit=5
pnpm --filter @watchparty/api demo:seed -- apply --limit=5

# 3. Carga completa (idempotente: retoma lo que falte).
pnpm --filter @watchparty/api demo:seed -- apply

# 4. Conteos actuales, para el informe.
pnpm --filter @watchparty/api demo:seed -- report
```

Códigos de salida: `0` todo bien, `1` hubo fallos (volver a correr `apply` retoma lo que quedó a
medias) y `2` configuración inválida (no se escribió nada).

### Prueba acotada y recuperación

Antes de la carga completa, con `--limit=5`:

1. La primera corrida debe crear 7 cuentas (5 masivas y las 2 de demostración) con sus perfiles.
2. La segunda debe informar `cuentas creadas: 0` y `perfiles creados: 0`.
3. Para comprobar la recuperación, cortar una corrida con Ctrl+C a la mitad y volver a correr: el
   total final tiene que ser el mismo que sin el corte.

Esos mismos comportamientos están cubiertos por los tests de `src/modules/demo-seed`: idempotencia,
retomar tras un fallo parcial, completar una cuenta sin perfil, no pisar perfiles ni correos ajenos,
el tope del lote chico y la retirada selectiva.

## Retirada selectiva

Para volver al estado anterior sin tocar nada ajeno:

```sh
pnpm --filter @watchparty/api demo:seed -- remove           # simulacro: no borra nada
pnpm --filter @watchparty/api demo:seed -- remove --apply   # borra solo lo del lote
```

Borra, en este orden, las reacciones del lote, sus comentarios, reseñas, notas y vistos, los perfiles y
las cuentas. Nunca toca partidos ni cuentas ajenas.

Las tablas de actividad referencian a `auth.users` **sin borrado en cascada**, por eso la actividad se
borra antes que las cuentas. Si una persona ajena reaccionó a un comentario del lote, ese comentario
**no se borra** (serían datos ajenos) y su autor **se conserva** con todo lo suyo; el informe lo
indica en «cuentas que se conservan».

## Impacto en métricas

Las cuentas y la actividad del lote son datos reales de la base para el reporter y los KPIs: cuentas,
calificaciones, reseñas y comentarios del entorno las incluyen. **No se modificó ninguna definición de
KPI.** Para excluirlas o medirlas aparte se identifican por `app_metadata.seed_batch` de la cuenta.
Quien use el reporter sobre este entorno tiene que tenerlo en cuenta al leer los números.

## Credenciales y privacidad

- Las contraseñas de las dos cuentas de demostración se entregan al PM y a QA **por un canal privado**,
  junto con los correos de esas dos cuentas. No se pegan en el repositorio, en un issue ni en este
  documento.
- Las 499 cuentas masivas no tienen contraseña conocida.
- Las reglas de acceso y privacidad no cambian: la nota, el visto y el historial son de cada cuenta,
  y cada una conserva su propia actividad privada.

## Informe final

Se completa al ejecutar y se adjunta al ticket. La salida de `apply` y `report` ya trae todo esto sin
contraseñas ni listas de correos:

| Dato                                                      | Valor                                   |
| --------------------------------------------------------- | --------------------------------------- |
| Entorno, URL y fecha                                      | _pendiente de ejecutar_                 |
| Huella del host de la base (la que imprime el script)     | _pendiente de ejecutar_                 |
| Identificador del lote                                    | `demo-501-v1` (o el de `DEMO_BATCH_ID`) |
| Cuentas registradas: antes → después                      | _pendiente de ejecutar_                 |
| Perfiles: antes → después                                 | _pendiente de ejecutar_                 |
| Cuentas registradas con perfil asociado (debe ser ≥ 501)  | _pendiente de ejecutar_                 |
| Perfiles sueltos y usuarios anónimos (no cuentan)         | _pendiente de ejecutar_                 |
| Partidos antes y después, y su huella (debe ser idéntica) | _pendiente de ejecutar_                 |
| Conteo por tabla principal                                | _pendiente de ejecutar_                 |
| Muestra de 10 perfiles (nombres y favoritos)              | _pendiente de ejecutar_                 |

**Cuentas y perfiles se presentan por separado**, y los perfiles sueltos, las sesiones y los usuarios
anónimos no cuentan como cuentas registradas.

### Brecha de los 5.000 registros

El documento del challenge pide 5.000 registros en las tablas principales. El script informa el conteo
de `teams`, `matches`, `profiles`, `rooms`, `room_comments`, `room_comment_reactions`,
`watched_matches`, `match_ratings` y `match_reviews`. **Identificar cuáles son las tablas aplicables y
señalar la brecha le corresponde al TechLead.** Esta carga no inventa registros para completar conteos
y no declara cumplido el challenge por el conteo de partidos.

## Guion de demo

Dos sesiones del navegador (una ventana normal y otra privada, o dos navegadores): la cuenta A en una
y la cuenta B en la otra. Ambas inician sesión por el flujo normal de la app, desde la URL de demo.

**Partidos elegidos** (completar con los ids de `DEMO_MATCH_IDS`; el enlace es
`<URL de demo>/matches/<id>`):

| #   | Partido, fecha y estado reales | Enlace directo al detalle |
| --- | ------------------------------ | ------------------------- |
| 1   | _pendiente de ejecutar_        | _pendiente_               |
| 2   | _pendiente de ejecutar_        | _pendiente_               |
| 3   | _pendiente de ejecutar_        | _pendiente_               |

Los partidos conservan su fecha y su estado originales: no se mueven a hoy ni se presentan como en
vivo.

### Ruta sobre un partido histórico real

Sirve para empezar el ensayo aunque siga pendiente la agenda de selecciones.

1. Cuenta A: iniciar sesión, abrir **Buscar**, escribir uno de los equipos del partido elegido y abrir
   su tarjeta. Se llega al detalle del partido.
2. En el detalle se ven el resultado real, la fecha y el estado «finalizado». Marcar **Marcar como
   visto** si todavía no figura.
3. Ver la **calificación** y la **reseña** ya sembradas; probar a editarlas.
4. Tocar **Entrar a la sala**: se ve la conversación sembrada y los Me gusta cruzados.
5. Cuenta B, en la otra sesión: abrir el mismo partido y entrar a la sala. Escribir un comentario y
   dar un Me gusta a uno de la cuenta A. Volver a la sesión A y comprobar que llegan.
6. Cada cuenta conserva su propia nota, reseña y visto: la B no ve la nota de la A.
7. Abrir **Perfil**: el **historial** de partidos vistos muestra el partido con su calificación.

La agenda actual (**Salas**) depende de la resolución de la agenda de selecciones (ver
`docs/integrations/football-data-org-fecha-fifa.md`): mientras no haya cobertura, la demo se apoya en
esta ruta histórica y no se presenta como agenda en vivo.

## Checklist de cierre

- [x] Procedimiento versionado, con tests de idempotencia, recuperación y retirada selectiva.
- [x] Guarda contra correr sobre una base no confirmada; sin credenciales en el repositorio.
- [ ] Entorno de demo, URL y base identificados; restricciones de Auth registradas.
- [ ] Prueba acotada (`--limit=5`) y recuperación comprobadas en el entorno de demo.
- [ ] Carga completa: al menos 501 cuentas registradas con perfil, informe adjunto.
- [ ] Dos cuentas de demostración entregadas al PM y a QA por un canal privado.
- [ ] Partidos elegidos, enlaces y guion completados.
- [ ] Partidos antes y después: idénticos.
- [ ] TechLead contrasta los conteos con el requisito de 5.000 y señala las brechas.
- [ ] QA registra un ensayo satisfactorio en el entorno identificado.
