# Runbook: SMTP propio para la recuperación de contraseña

Documenta **cómo se configura, se diagnostica y se verifica el envío de correo** de Supabase Auth en
producción. Complementa [`password-recovery-redirects.md`](./password-recovery-redirects.md), que
cubre a dónde vuelve el enlace; este runbook cubre que **el correo llegue a enviarse**.

Es configuración del proyecto hospedado en Supabase: no vive en el repositorio y no se versiona.

## Por qué hace falta

La recuperación de contraseña siempre necesita enviar un correo, aunque la confirmación de registro
esté desactivada. Dos síntomas de producción apuntan al envío y no a la web:

| Síntoma reportado                                    | Qué indica                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `429: email rate limit exceeded` en los logs de Auth | Se llegó al límite de envío del servicio de correo en uso.           |
| El proveedor rechaza usuario o contraseña SMTP       | Supabase llega al servidor SMTP, pero las credenciales no le sirven. |

No son necesariamente la misma causa y no se registraron en el mismo momento: **confirmar la
configuración vigente y la cronología antes de atribuirlos a un único origen.**

El servicio de correo incorporado de Supabase es para pruebas y tiene un límite de envío muy bajo y
fijo. Para producción hace falta un SMTP propio.

La web no es la causa de ninguno de los dos: `ForgotPasswordPage` sólo llama a
`supabase.auth.resetPasswordForEmail` y, si el envío falla, muestra un aviso presentable que no
revela el error del proveedor ni confirma el envío (ver «Qué ve la persona» más abajo).

## Responsable y registro de la configuración

Completar y mantener esta tabla. **No pegar acá contraseñas, tokens, claves ni correos de
personas.**

| Dato                                             | Valor                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Responsable de la configuración SMTP             | _pendiente de coordinar_                                                                     |
| Quién tiene acceso al dashboard de Supabase      | _pendiente de coordinar_                                                                     |
| Proveedor SMTP                                   | Gmail (cuenta dedicada de WatchParty, con contraseña de aplicación)                          |
| Host y puerto                                    | `smtp.gmail.com`, puerto 465 (TLS directo; el 587 usa STARTTLS)                              |
| Remitente (dirección y nombre) y su verificación | Dirección de la cuenta de Gmail dedicada (la misma que el usuario SMTP); nombre `WatchParty` |
| Límite de envío configurado (correos por hora)   | 30 por hora (ver «Límite de envío»)                                                          |
| Fecha de la última verificación de entrega       | _pendiente_                                                                                  |
| Versión de la web desplegada al verificar        | _pendiente_                                                                                  |

## Configuración en Supabase

Dashboard → **Authentication → Emails → SMTP Settings** → activar **Custom SMTP** y completar:

- **Sender email** y **Sender name**: el remitente verificado en el proveedor.
- **Host**, **Port**, **Username** y **Password** del proveedor SMTP.

Después, en **Authentication → Rate Limits**, definir el límite de envío (ver más abajo).

### Remitente y proveedor

- El remitente tiene que estar **verificado en el proveedor** (dominio con SPF y DKIM, o la
  dirección verificada que el proveedor exija). Un remitente sin verificar termina en spam o es
  rechazado.
- Si se usa **Gmail**, la cuenta necesita verificación en dos pasos y una **contraseña de
  aplicación**: la contraseña normal de la cuenta no sirve para SMTP, y es la causa más común de
  «usuario o contraseña rechazados». El usuario es la dirección completa. Una cuenta de Gmail tiene
  además un tope diario de envíos bajo, pensado para uso personal; para producción conviene un
  proveedor transaccional con dominio propio. Confirmar los topes vigentes en la documentación del
  proveedor elegido.
- **No desactivar controles de seguridad para que el envío funcione** (por ejemplo, no permitir
  accesos «menos seguros» ni saltear la conexión cifrada): se corrige la credencial o la
  configuración, no la protección.

### Credenciales

- La contraseña SMTP se escribe **únicamente** en el campo Password de Supabase (o en el gestor de
  secretos del proveedor). Nunca en el repositorio, en un issue, en una captura ni en un chat.
- Si alguna credencial se expuso, **revocarla y generar otra** antes de seguir: cambiar la
  configuración no invalida lo que ya circuló.
- Preferir una credencial exclusiva para este uso (contraseña de aplicación o API key propia), que
  se pueda revocar sin afectar a otras cosas.

## Límite de envío

Supabase permite fijar cuántos correos por hora puede enviar el proyecto. Definirlo con criterio:

1. Estimar cuántas recuperaciones puede haber en la hora de mayor uso.
2. Fijar un límite **algo por encima de ese pico**: lo bastante alto para no cortar a personas
   reales, lo bastante bajo para que un abuso no agote el cupo del proveedor ni dispare costos.
3. Verificar que el límite de Supabase **no supere el tope del proveedor SMTP**: si lo supera, el
   corte lo pone el proveedor y vuelve el rechazo.
4. Registrar el valor elegido y la estimación en la tabla de arriba.

Si el límite se alcanza, el pedido falla con `429` (`over_email_send_rate_limit`). La web lo trata
como cualquier otro fallo de envío: aviso recuperable y reintento.

## Diagnóstico

Antes de cambiar nada, **registrar la fecha y hora exactas y el código de error** (en hora de
Buenos Aires y UTC), con evidencia sin credenciales ni enlaces de recuperación.

1. **Configuración vigente:** en Authentication → Emails → SMTP Settings, ver si Custom SMTP está
   activado y qué host, puerto y remitente tiene (sin copiar la contraseña).
2. **Logs:** Authentication → Logs, filtrando por el momento del reporte. Buscar el evento del
   pedido de recuperación y el error del envío.
3. **Contrastar con el error del proveedor:**

| Lo que muestran los logs                                            | Causa probable                                               | Qué hacer                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `429` / `over_email_send_rate_limit`                                | Se alcanzó el límite de envío.                               | Revisar SMTP propio activado y el límite configurado.          |
| Autenticación rechazada (`535` o «usuario/contraseña no aceptados») | Usuario o contraseña SMTP incorrectos, vencidos o revocados. | Regenerar la credencial y guardarla sólo en Supabase.          |
| Tiempo de espera o conexión rechazada                               | Host o puerto incorrectos, o bloqueo de red.                 | Verificar host y puerto contra la documentación del proveedor. |
| El envío se acepta pero el correo no llega                          | Remitente sin verificar o correo en spam.                    | Verificar dominio/remitente y revisar la carpeta de spam.      |

4. Corregir **según la causa verificada**, de a un cambio por vez, y repetir la prueba.

## Qué ve la persona

Ante cualquier fallo de envío, `ForgotPasswordPage` muestra «No pudimos enviar el correo. Intentá
de nuevo en unos instantes.», conserva el correo escrito y deja reenviar. No muestra el texto del
proveedor, códigos ni la palabra SMTP, y no afirma que el correo se haya enviado.

Un enlace inválido o vencido, ya en la pantalla de cambio, muestra «El enlace no es válido o ya
venció» con el acceso a pedir uno nuevo.

## Verificación

### Por tests (sin correo real)

```sh
pnpm --filter web test
```

`forgot-password.test.tsx` cubre el límite de envío (429), las credenciales SMTP rechazadas, el
proveedor caído y el reintento posterior, y comprueba que ninguno revela datos internos.

### A mano, contra producción

Con una **cuenta de prueba** (nunca una cuenta real) y la configuración de arriba ya aplicada. El
recorrido completo depende además de que el enlace del correo vuelva a una pantalla que lo procese
(ver `password-recovery-redirects.md`).

1. Pedir la recuperación con el correo de la cuenta de prueba desde `/forgot-password`.
2. Comprobar que la pantalla confirma el pedido y que en los logs de Authentication no aparece un
   error de autenticación SMTP ni de límite de envío.
3. Comprobar que el correo **llega** a la bandeja de la cuenta de prueba, con el remitente
   configurado.
4. Abrir el enlace, guardar una contraseña nueva y comprobar el cierre de sesión.
5. Iniciar sesión con la contraseña nueva; la anterior ya no debe servir.
6. Probar el fallo: un enlace ya usado o vencido muestra el mensaje recuperable.
7. Registrar en el ticket la fecha, la versión desplegada y el resultado de cada paso. **No pegar
   el correo recibido ni el enlace**: lleva el token.

## Qué no se documenta acá

Este runbook no incluye ni debe incluir:

- La contraseña, la contraseña de aplicación, la API key ni ninguna credencial SMTP.
- El project ref de Supabase, `anon key`, `service_role key` ni ningún JWT.
- Tokens o enlaces de recuperación, ni correos o datos personales de quienes reportan o prueban.

## Checklist de cierre

- [x] Custom SMTP activado, con remitente verificado y credenciales guardadas sólo en Supabase.
- [x] Límite de envío definido y registrado, sin superar el tope del proveedor.
- [ ] Causa del rechazo y del `429` confirmada con los logs, con fecha y hora exactas.
- [ ] Entrega verificada a una cuenta de prueba, sin errores de autenticación ni de límite.
- [ ] Recorrido completo verificado (correo, enlace, contraseña nueva, cierre de sesión, ingreso).
- [ ] Responsable y accesos de la configuración registrados en la tabla.
- [ ] QA registra el retest con persona, fecha, versión y evidencia.
