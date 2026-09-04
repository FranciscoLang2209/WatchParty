export interface CheckResult {
  label: string;
  expectedStatus: number;
  actualStatus: number;
  passed: boolean;
}

export async function checkStatus(
  label: string,
  url: string,
  expectedStatus: number,
  accessToken?: string,
): Promise<CheckResult> {
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(url, { headers });

  return {
    label,
    expectedStatus,
    actualStatus: response.status,
    passed: response.status === expectedStatus,
  };
}

export function printResults(results: CheckResult[]): boolean {
  for (const result of results) {
    const status = result.passed ? 'OK' : 'FALLÓ';
    console.log(
      `[${status}] ${result.label} — esperado ${result.expectedStatus}, obtuvo ${result.actualStatus}`,
    );
  }

  const failures = results.filter((result) => !result.passed);

  if (failures.length > 0) {
    console.error(`\n${failures.length} chequeo(s) fallaron.`);
    return false;
  }

  console.log('\nTodos los chequeos pasaron.');
  return true;
}
