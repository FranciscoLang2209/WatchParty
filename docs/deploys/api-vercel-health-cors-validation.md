# Validación de la API en Vercel — health y CORS

## Resumen

Se validó, contra el despliegue real de producción, que la API responde correctamente en
`/health`, que CORS autoriza únicamente el origen configurado, y que un 401 de autenticación
se distingue de un bloqueo por CORS.

## Datos del despliegue

- **Fecha de validación**: 2026-09-10
- **URL**: `https://watchparty-api-ten.vercel.app`
- **SHA desplegado en producción**: `6206bbd` (rama `main`, merge de `feature/api-football-client`)

## Health check

```
GET /health
→ 200 OK
{"status":"ok"}
```

## CORS

| Caso                 | Origen enviado                            | Resultado                                                          |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Origen autorizado    | `https://watch-party-web-cfeq.vercel.app` | `200 OK`, `Access-Control-Allow-Origin` presente y coincide exacto |
| Origen no autorizado | `https://sitio-cualquiera.com`            | `200 OK`, sin header `Access-Control-Allow-Origin`                 |

`WEB_ORIGIN` coincide exactamente con el origen del frontend, sin slash final.

## Preflight

| Método solicitado | Resultado                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`             | `204 No Content`, `Access-Control-Allow-Methods: GET`, `Access-Control-Allow-Headers: Authorization` — autorizado |
| `PUT`             | `204 No Content`, pero `Access-Control-Allow-Methods` sigue devolviendo sólo `GET` — **no autorizado**            |

**Limitación registrada**: el SHA `6206bbd` no incluye soporte de `PUT` (depende de WAT-130, todavía sin
integrar). Un navegador real bloquearía cualquier `PUT` porque no aparece en `Access-Control-Allow-Methods`.
Esta comprobación debe repetirse cuando WAT-130 esté integrado. No se agregó ningún adaptador ni wrapper
para forzar `PUT` antes de tiempo.

## 401 distinguido de un bloqueo CORS

```
GET /matches (sin token, con Origin autorizado)
→ 401 Unauthorized
Access-Control-Allow-Origin: https://watch-party-web-cfeq.vercel.app
{"error":{"code":"UNAUTHORIZED","message":"No autenticado."}}
```

El header CORS está presente junto al 401: confirma que el pedido **sí** fue autorizado por CORS, y que el
401 es un rechazo de autenticación genuino — no una confusión con un bloqueo de origen.

## Sin código modificado

No se encontró ninguna falla reproducible durante esta validación. No se realizó ningún cambio de código,
`vercel.json` ni adaptador serverless.

## Rollback disponible

El proyecto `watchparty-api` en Vercel mantiene el historial de deployments anteriores; un rollback a una
versión previa está disponible desde la pestaña **Deployments** del proyecto, sin acción adicional.
