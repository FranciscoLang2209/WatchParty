import { createServiceRoleClient } from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkMatchReviewApi } from './checks/match-review-api-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();

  const results = await checkMatchReviewApi(adminClient);

  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
