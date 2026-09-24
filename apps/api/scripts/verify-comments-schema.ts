import { createServiceRoleClient } from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkCommentConstraints } from './checks/comment-constraints-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();

  const results = await checkCommentConstraints(adminClient);

  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
