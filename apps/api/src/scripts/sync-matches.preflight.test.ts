import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * El script carga `apps/api/.env` (`--env-file-if-exists`), y Node no pisa una
 * variable ya definida, ni siquiera vacía. Se definen vacías para que un `.env`
 * local no altere el resultado ni apunte el test a una base real.
 */
const BLANK_ENV: Record<string, string> = Object.fromEntries(
  [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
    'WEB_ORIGIN',
    'FOOTBALL_DATA_ORG_BASE_URL',
    'FOOTBALL_DATA_ORG_API_KEY',
    'API_FOOTBALL_BASE_URL',
    'API_FOOTBALL_KEY',
    'MATCHES_SYNC_PROVIDER',
  ].map((name) => [name, '']),
);

interface Recorder {
  url: string;
  requests: string[];
  server: Server;
}

/** Servidor local que registra cada pedido: hace de doble del proveedor o de Supabase. */
async function startRecorder(): Promise<Recorder> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}`, requests, server };
}

/** Corre el comando real (asíncrono, para que los dobles sigan atendiendo). */
function runSyncCommand(
  env: Record<string, string>,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@watchparty/api', 'matches:sync'], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...BLANK_ENV, ...env },
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60_000);

    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

const servers: Server[] = [];

async function startDoubles(): Promise<{ provider: Recorder; database: Recorder }> {
  const provider = await startRecorder();
  const database = await startRecorder();
  servers.push(provider.server, database.server);

  return { provider, database };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('matches:sync — preflight contra dobles locales', () => {
  it('con una variable obligatoria incompleta, ni el proveedor ni la base reciben pedidos', async () => {
    const { provider, database } = await startDoubles();

    const result = await runSyncCommand({
      FOOTBALL_DATA_ORG_BASE_URL: provider.url,
      FOOTBALL_DATA_ORG_API_KEY: 'test-key',
      SUPABASE_URL: database.url,
      SUPABASE_ANON_KEY: 'test-anon-key',
      WEB_ORIGIN: 'http://localhost:5173',
      // Falta SUPABASE_SERVICE_ROLE_KEY a propósito.
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(provider.requests).toEqual([]);
    expect(database.requests).toEqual([]);
  });

  it('control: con la configuración completa el comando sí llega a la base de prueba', async () => {
    const { provider, database } = await startDoubles();

    const result = await runSyncCommand({
      FOOTBALL_DATA_ORG_BASE_URL: provider.url,
      FOOTBALL_DATA_ORG_API_KEY: 'test-key',
      SUPABASE_URL: database.url,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      WEB_ORIGIN: 'http://localhost:5173',
    });

    // Sin preflight fallido el comando avanza y toca la base (aquí, un doble que responde 500).
    expect(database.requests.length).toBeGreaterThan(0);
    expect(result.status).not.toBe(0);
  });
});
