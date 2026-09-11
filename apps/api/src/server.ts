import { createApp } from './app.js';
import { createSupabaseSportsDataClient } from './modules/matches/infrastructure/supabase-sports-data-client.js';
import { SupabaseMatchStore } from './modules/matches/infrastructure/supabase-match-store.js';
import { SupabaseMatchCatalog } from './modules/matches/infrastructure/supabase-match-catalog.js';

// Composición real del proceso: acá, y solo acá, se decide que el catálogo
// de partidos es el respaldado por Supabase. Si falta configuración
// requerida (por ejemplo SUPABASE_SERVICE_ROLE_KEY), la importación de
// `env.ts` ya falló con un error explícito antes de llegar acá — no hay
// fallback a LocalMatchCatalog ni a un catálogo vacío.

const sportsDataClient = createSupabaseSportsDataClient();
const matchStore = new SupabaseMatchStore(sportsDataClient);
const matchCatalog = new SupabaseMatchCatalog(matchStore);

const app = createApp(matchCatalog);

const PORT = Number(process.env.PORT ?? 3000); //lo que hace esto es decir -> si hay un puerto elegido dentro de las variables de entorno, elegilo. Sino, usa el 3000.

app.listen(PORT, () => {
  //aca pongo el listener de la app al puerto que acabo de crear. Me permite poder testear app sin tener que prender el servidor
  console.log(`API listening on PORT: ${PORT}`);
});
