import {
  createServiceRoleClient,
  createAnonClient,
  createAuthenticatedClient,
  getTempUserAccessToken,
} from './utils/supabase-clients.js';
import { printResults } from './utils/db-checks.js';
import { checkCommentConstraints } from './checks/comment-constraints-checks.js';
import { checkCommentReactions } from './checks/comment-reactions-checks.js';

async function main(): Promise<void> {
  const adminClient = createServiceRoleClient();
  const anonClient = createAnonClient();
  const accessToken = await getTempUserAccessToken();
  const authenticatedClient = createAuthenticatedClient(accessToken);

  const constraintResults = await checkCommentConstraints(adminClient);
  const reactionResults = await checkCommentReactions(adminClient, anonClient, authenticatedClient);
  const results = [...constraintResults, ...reactionResults];

  const allPassed = printResults(results);

  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('La verificación se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
