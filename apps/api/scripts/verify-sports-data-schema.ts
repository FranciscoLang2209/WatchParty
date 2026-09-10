import {
  createServiceRoleClient,
  createAnonClient,
  createAuthenticatedClient,
  getTempUserAccessToken,
} from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkConstraints } from './checks/constraints-checks.js';
import { checkRls } from './checks/rls-checks.js';
import { checkLeaseLifecycle } from './checks/lease-checks.js';
import { checkMatchStore } from './checks/match-store-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();
  const anonClient = createAnonClient();
  const accessToken = await getTempUserAccessToken();
  const authenticatedClient = createAuthenticatedClient(accessToken);

  const results = [
    ...(await checkConstraints(adminClient)),
    ...(await checkRls(anonClient, authenticatedClient, adminClient)),
    ...(await checkLeaseLifecycle(adminClient)),
    ...(await checkMatchStore(adminClient)),
  ];

  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
