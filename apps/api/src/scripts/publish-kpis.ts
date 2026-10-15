import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isReporterEnv } from '../modules/reporting/domain/kpi-catalog.js';
import { publishReport } from '../modules/reporting/application/publish-report.js';
import { PAYLOAD_FILE, ARCHIVE_FILE } from '../modules/reporting/application/run-report.js';

async function main(): Promise<void> {
  const env = process.env.REPORTER_ENV?.trim();
  if (!isReporterEnv(env)) {
    console.error('REPORTER_ENV debe ser "dev" o "prod".');
    process.exitCode = 2;
    return;
  }
  const directory = resolve(process.env.REPORTER_OUTPUT_DIR?.trim() || 'reporter-output');
  const archive = JSON.parse(await readFile(join(directory, ARCHIVE_FILE), 'utf8'));
  if (archive.simulated !== false || archive.complete !== true || archive.env !== env) {
    throw new Error('Invalid collection archive');
  }
  const rows: unknown = JSON.parse(await readFile(join(directory, PAYLOAD_FILE), 'utf8'));
  const receipt = await publishReport(rows, env);
  await writeFile(join(directory, 'publication.json'), JSON.stringify(receipt, null, 2), 'utf8');
  console.log(`Reporter ${env}: publicación ${receipt.ok ? 'verificada' : receipt.reason}.`);
  process.exitCode = receipt.ok ? 0 : 1;
}

main().catch(() => {
  console.error('No se pudo publicar el lote del reporter.');
  process.exitCode = 1;
});
