export interface CheckResult {
  label: string;
  passed: boolean;
  detail?: string;
}

export function printResults(results: CheckResult[]): boolean {
  for (const result of results) {
    const status = result.passed ? 'OK' : 'FALLÓ';
    const detail = result.detail ? ` — ${result.detail}` : '';
    console.log(`[${status}] ${result.label}${detail}`);
  }
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) {
    console.error(`\n${failures.length} chequeo(s) fallaron.`);
    return false;
  }
  console.log('\nTodos los chequeos pasaron.');
  return true;
}
