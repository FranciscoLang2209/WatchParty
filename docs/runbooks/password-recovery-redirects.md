# Runbook: Redirect URLs de la recuperación de contraseña

Cierra el flujo de recuperación (WAT-114). Documenta **qué URLs hay que habilitar en Supabase**
para que el enlace del correo abra la pantalla de cambio de contraseña en cada entorno.

No cambia el proveedor de Auth ni agrega UI: la pantalla es la de WAT-121 y el `redirectTo` lo
declara WAT-120.

## Por qué hace falta

`ForgotPasswordPage` pide el correo con:

```ts
supabase.auth.resetPasswordForEmail(email, {
  redirectTo: `${window.location.origin}/reset-password`,
});
```

El origen se lee **en ejecución**, así que el mismo build sirve local, preview y producción sin
ningún dominio escrito en el código. A cambio, Supabase sólo va a respetar ese `redirectTo` si la
URL está en su allow-list: cualquier destino no autorizado se descarta silenciosamente y el
enlace del correo termina en el Site URL, no en `/reset-password`.

Sin la URL habilitada el síntoma es siempre el mismo: el enlace abre la app, pero
`/reset-password` muestra «El enlace no es válido o ya venció» porque nunca llega el evento
`PASSWORD_RECOVERY`.

## Las URLs a habilitar

Todas terminan en `/reset-password`, sin barra final y sin query.

| Entorno    | Origen                                     | Redirect URL                                             |
| ---------- | ------------------------------------------ | -------------------------------------------------------- |
| Local      | `http://localhost:5173` (Vite, ver README) | `http://localhost:5173/reset-password`                   |
| Preview    | la URL que Vercel genera por cada PR       | `https://*-watchparty-web.vercel.app/reset-password`     |
| Producción | `https://watch-party-web-cfeq.vercel.app`  | `https://watch-party-web-cfeq.vercel.app/reset-password` |

Notas por entorno:

- **Local** usa `http`, no `https`, y el puerto por defecto de Vite. Si alguien levanta la web en
  otro puerto (`--port`), esa variante también hay que habilitarla: la lista es de coincidencia
  exacta salvo por los comodines.
- **Preview** cambia de URL en cada pull request, así que se habilita con el patrón comodín en
  vez de una por una. Supabase acepta `*` en `additional_redirect_urls`; confirmar el patrón
  contra una URL de preview real antes de darlo por bueno.
- **Producción** es la URL registrada en el README. **Si WAT-137 cambia el dominio, hay que
  actualizar esta tabla y la allow-list en el mismo cambio**, o la recuperación queda rota en
  producción sin aviso.

## Dónde se configuran

### Proyecto hospedado (preview y producción)

Dashboard de Supabase → **Authentication → URL Configuration**:

- **Site URL**: el origen de producción.
- **Redirect URLs**: las tres filas de la tabla de arriba.

Es configuración del proyecto: no vive en el repositorio y no se versiona.

### Supabase local

`supabase/config.toml`, sección `[auth]`:

```toml
site_url = "http://localhost:5173"
additional_redirect_urls = ["http://localhost:5173/reset-password"]
```

Después de tocar el archivo hay que reiniciar el stack para que tome los valores:

```sh
pnpm supabase:stop && pnpm dev
```

> **Estado actual:** el repositorio todavía tiene los valores por defecto de la CLI
> (`site_url = "http://127.0.0.1:3000"`), que apuntan a la API y no a la web. Con esos valores el
> enlace de recuperación **no** funciona contra el Supabase local. El cambio no se aplica en esta
> PR porque `supabase/config.toml` es del alcance de la configuración de Supabase, no de este
> ticket; queda registrado acá para que se decida dónde corresponde.

## Qué no se documenta acá

Deliberadamente, este runbook no incluye ni debe incluir:

- El **project ref** ni la URL del proyecto Supabase.
- `anon key`, `service_role key` ni ningún JWT.
- Tokens de recuperación, cookies de sesión o correos reales.

Los valores locales los imprime `pnpm supabase:status` en la máquina de cada quien; los del
proyecto hospedado viven en el dashboard y en las variables de entorno de Vercel.

## Verificación

### Por tests (sin correo real)

Todo el flujo está cubierto con mocks de Supabase Auth: ningún test manda un correo ni usa una
cuenta real.

```sh
pnpm --filter web test
```

| Caso                                             | Dónde                                          |
| ------------------------------------------------ | ---------------------------------------------- |
| El pedido declara `redirectTo` con el origen     | `forgot-password.test.tsx`                     |
| Sin evento de recuperación no hay formulario     | `reset-password.test.tsx`                      |
| Sin sesión no hay formulario                     | `reset-password.test.tsx`                      |
| Enlace inválido con `aria-live`                  | `reset-password.test.tsx`                      |
| El fallo no filtra token, correo ni internals    | `reset-password.test.tsx`                      |
| Error de `updateUser` presentable y reintentable | `reset-password.test.tsx`                      |
| Éxito → cierra sesión y vuelve al login          | `reset-password.test.tsx`                      |
| Volver a entrar con la contraseña nueva          | `reset-password.test.tsx`, «el flujo completo» |
| Sólo `PASSWORD_RECOVERY` habilita el cambio      | `auth.test.tsx`                                |
| `/reset-password` es pública                     | `router.test.tsx`                              |

### A mano, contra el stack local

Una vez habilitada la URL en `supabase/config.toml`:

1. `pnpm dev` y registrar una cuenta en `http://localhost:5173/register`.
2. Cerrar sesión e ir a `/forgot-password`; pedir el enlace.
3. Abrir Inbucket (la URL la imprime `pnpm supabase:status`) y seguir el enlace del correo.
4. Debe abrir `/reset-password` **con el formulario**, no con el mensaje de enlace inválido.
5. Guardar una contraseña nueva: tiene que redirigir a `/login`.
6. Entrar con la contraseña nueva. La anterior ya no sirve.
7. Volver a abrir el mismo enlace del correo: ahora debe mostrar el mensaje recuperable, porque
   la sesión de recuperación se cerró al guardar.

No pegar en el PR ni en un issue el contenido del correo: el enlace lleva el token.

## Checklist de cierre

- [x] Los fallos son presentables, con `aria-live`, y no revelan token, contraseña, correo ni el
      mensaje interno de Supabase.
- [x] El flujo exitoso permite volver a iniciar sesión con la contraseña nueva.
- [x] Los tests usan mocks: no se manda ningún correo real.
- [x] La documentación distingue local, preview y producción.
- [x] No hay project ref, keys, tokens ni cookies en este documento.
- [ ] Habilitar las Redirect URLs en el dashboard del proyecto hospedado (configuración, fuera
      del repo).
- [ ] Decidir dónde se aplica el cambio de `supabase/config.toml` para el entorno local.
- [ ] Actualizar la tabla si WAT-137 cambia el dominio de producción.
