import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

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

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
