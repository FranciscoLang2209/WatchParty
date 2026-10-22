import pg from 'pg';
import { printResults } from './utils/db-checks.js';
import { checkRatedMatchRate } from './checks/rated-match-rate-checks.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Conexión directa a Postgres: el agregado vive en el esquema `reporting`,
 * que PostgREST no expone, y los checks necesitan fijar fechas y cambiar de
 * rol. Solo contra el Supabase local: este script siembra datos sintéticos.
 */
function localDatabaseUrl(): string {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error('Falta la variable de entorno SUPABASE_DB_URL. Revisá tu archivo .env.');
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error('SUPABASE_DB_URL debe apuntar al Supabase local.');
  }
  return url;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: localDatabaseUrl() });
  await client.connect();

  try {
    await client.query('begin');
    const results = await checkRatedMatchRate(client);
    const allPassed = printResults(results);
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    await client.query('rollback');
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
