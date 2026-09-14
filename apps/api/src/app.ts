import express, { type Express } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createMatchesRouter } from './modules/matches/http/matches-router.js';
import type { MatchCatalog } from './modules/matches/domain/match-catalog.js';
import { createSupabaseSportsDataClient } from './modules/matches/infrastructure/supabase-sports-data-client.js';
import { SupabaseMatchStore } from './modules/matches/infrastructure/supabase-match-store.js';
import { SupabaseMatchCatalog } from './modules/matches/infrastructure/supabase-match-catalog.js';

/**
 * Cambio del ticket WAT-106: la app ya no crea su propio MatchCatalog de
 * manera hardcodeada — ahora lo recibe por parámetro (inyección de
 * dependencias). Quien decide cuál usar (Supabase real, o un doble en
 * tests) es responsabilidad de quien llama a createApp, no de este archivo.
 */
export function createApp(matchCatalog: MatchCatalog): Express {
  const app = express();

  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin === env.WEB_ORIGIN);
      },
      methods: ['GET'],
      allowedHeaders: ['Authorization'],
    }),
  );

  app.use(express.json()); // Metodo middle wear -> (si el pedido que llega es un json, lo deserealiza)

  app.get('/health', (_req, res) => {
    //request http para ver si está ok el servidor
    res.status(200).json({ status: 'ok' });
  });

  app.use('/matches', createMatchesRouter(matchCatalog));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// Composición real del proceso: acá, y solo acá, se decide que el catálogo
// de partidos es el respaldado por Supabase. Si falta configuración
// requerida (por ejemplo SUPABASE_SERVICE_ROLE_KEY), la importación de
// `env.ts` ya falló con un error explícito antes de llegar acá — no hay
// fallback a LocalMatchCatalog ni a un catálogo vacío.
//
// Vive en este archivo por el ticket WAT-138: el preset Express de Vercel
// carga este módulo como la función serverless y nunca ejecuta `server.ts`,
// así que la app compuesta tiene que ser el `default export` de acá. Al
// correr localmente, `server.ts` importa esta misma instancia y le agrega
// el `listen` — una sola composición para ambos entornos.

const sportsDataClient = createSupabaseSportsDataClient();
const matchStore = new SupabaseMatchStore(sportsDataClient);
const matchCatalog = new SupabaseMatchCatalog(matchStore);

export default createApp(matchCatalog);
