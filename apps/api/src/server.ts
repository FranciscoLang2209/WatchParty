import app from './app.js';

const PORT = Number(process.env.PORT ?? 3000); //lo que hace esto es decir -> si hay un puerto elegido dentro de las variables de entorno, elegilo. Sino, usa el 3000.

app.listen(PORT, () => {
  //aca pongo el listener de la app al puerto que acabo de crear. Me permite poder testear app sin tener que prender el servidor
  console.log(`API listening on PORT: ${PORT}`);
});
