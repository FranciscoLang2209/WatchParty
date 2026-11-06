import { createServiceRoleClient } from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkMatchReviewsList } from './checks/match-reviews-list-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();

  const results = await checkMatchReviewsList(adminClient);

  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
