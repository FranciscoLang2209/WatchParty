import { getAccessToken } from './utils/temp-auth.js';
import { checkStatus, printResults, type CheckResult } from './utils/http-checks.js';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

async function fetchMatchList(
  accessToken: string,
): Promise<{ result: CheckResult; matchId: string | undefined }> {
  const listUrl = `${API_BASE_URL}/matches`;
  const response = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

  const result: CheckResult = {
    label: 'GET /matches (con token)',
    expectedStatus: 200,
    actualStatus: response.status,
    passed: response.status === 200,
  };

  const body = (await response.json().catch(() => null)) as {
    matches?: Array<{ id: string }>;
  } | null;
  return { result, matchId: body?.matches?.[0]?.id };
}

async function runChecks(accessToken: string): Promise<CheckResult[]> {
  const { result: listResult, matchId } = await fetchMatchList(accessToken);

  if (!matchId) {
    throw new Error('El listado de partidos vino vacío: no hay un ID real para probar el detalle.');
  }

  return [
    listResult,
    await checkStatus(
      'GET /matches/:id (existente, con token)',
      `${API_BASE_URL}/matches/${matchId}`,
      200,
      accessToken,
    ),
    await checkStatus(
      'GET /matches/:id (inexistente, con token)',
      `${API_BASE_URL}/matches/no-existe-${Date.now()}`,
      404,
      accessToken,
    ),
    await checkStatus('GET /matches (sin token)', `${API_BASE_URL}/matches`, 401),
  ];
}

async function main(): Promise<void> {
  const accessToken = await getAccessToken('matches');
  const results = await runChecks(accessToken);
  const allPassed = printResults(results);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('El smoke test se interrumpió con un error inesperado:', error);
  process.exitCode = 1;
});
