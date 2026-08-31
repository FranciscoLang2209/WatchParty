# Módulo de partidos (matches)

## Modelo canónico

`domain/match.ts` define `Match` y `MatchStatus`: el único modelo de partido
que debe usarse en todo el módulo (handlers HTTP incluidos).

## Puerto `MatchCatalog`

`domain/match-catalog.ts` define el puerto asíncrono que exponen todos los
catálogos de partidos:

```ts
interface MatchCatalog {
  list(): Promise<readonly Match[]>;
  findById(id: string): Promise<Match | null>;
}
```

Los consumidores HTTP dependen únicamente de este puerto, nunca de una
implementación concreta.

## Implementación actual: `LocalMatchCatalog` (temporal)

`infrastructure/local-match-catalog.ts` implementa `MatchCatalog` con datos
embebidos en memoria (al menos tres partidos, con IDs estables). Es una
solución transitoria mientras no exista un proveedor deportivo real.

**Reemplazo futuro:** cuando se integre un proveedor externo, se debe crear
un nuevo adaptador (por ejemplo `provider-match-catalog.ts`) que implemente
el mismo puerto `MatchCatalog`. Como los consumidores HTTP solo conocen la
interfaz, ese cambio no debería requerir modificar ni el dominio ni el
código que consume el catálogo.

## Fuera de alcance de este módulo (por ahora)

Endpoints HTTP, autenticación, proveedor deportivo real, persistencia
remota, datos en vivo y funcionalidades sociales.
