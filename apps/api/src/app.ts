import express, { type Express } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createMatchesRouter } from './modules/matches/http/matches-router.js';
import type { MatchCatalog } from './modules/matches/domain/match-catalog.js';

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
