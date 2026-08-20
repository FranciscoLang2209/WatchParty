import express from 'express';

const app = express();

app.use(express.json()); // Metodo middle wear -> (si el pedido que llega es un json, lo deserealiza)

app.get('/health', (_req, res) => {
  //request http para ver si está ok el servidor
  res.status(200).json({ status: 'ok' });
});

export default app;
