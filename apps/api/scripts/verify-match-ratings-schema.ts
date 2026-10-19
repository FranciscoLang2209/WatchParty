import {
  createServiceRoleClient,
  createAnonClient,
  createAuthenticatedClient,
  getTempUserAccessToken,
} from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkMatchRatingsConstraints } from './checks/match-ratings-constraints-checks.js';
import { checkMatchRatingsRls } from './checks/match-ratings-rls-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();
  const anonClient = createAnonClient();
  const accessToken = await getTempUserAccessToken();
  const authenticatedClient = createAuthenticatedClient(accessToken);

  const results = [
    ...(await checkMatchRatingsConstraints(adminClient)),
    ...(await checkMatchRatingsRls(anonClient, authenticatedClient, adminClient)),
  ];

  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
