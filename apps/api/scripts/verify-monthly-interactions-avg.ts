import { printResults } from './utils/db-checks.js';
import { createLocalDatabaseClient } from './utils/reporting-fixtures.js';
import { checkMonthlyInteractionsAvg } from './checks/monthly-interactions-avg-checks.js';

async function main(): Promise<void> {
  const client = createLocalDatabaseClient();
  await client.connect();

  try {
    await client.query('begin');
    const results = await checkMonthlyInteractionsAvg(client);
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
