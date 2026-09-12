import {
  createServiceRoleClient,
  createAnonClient,
  createAuthenticatedClient,
  getTempUserAccessToken,
} from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkProfileConstraints } from './checks/profile-constraints-checks.js';
import { checkProfileRls } from './checks/profile-rls-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();
  const anonClient = createAnonClient();
  const accessToken = await getTempUserAccessToken();
  const authenticatedClient = createAuthenticatedClient(accessToken);

  const results = [
    ...(await checkProfileConstraints(adminClient)),
    ...(await checkProfileRls(anonClient, authenticatedClient, adminClient)),
  ];

  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
