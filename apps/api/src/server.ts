import app from './app.js';

// Punto de entrada local: la app ya viene compuesta desde `app.ts` (ver
// WAT-138), así que acá sólo se le agrega el `listen`. En Vercel este
// archivo no se ejecuta: el runtime invoca directamente el default export
// de `app.ts` como función serverless.

const PORT = Number(process.env.PORT ?? 3000); //lo que hace esto es decir -> si hay un puerto elegido dentro de las variables de entorno, elegilo. Sino, usa el 3000.

app.listen(PORT, () => {
  //aca pongo el listener de la app al puerto que acabo de crear. Me permite poder testear app sin tener que prender el servidor
  console.log(`API listening on PORT: ${PORT}`);
});
