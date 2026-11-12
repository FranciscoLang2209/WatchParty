import { createHash } from 'node:crypto';
import {
  COUNTED_TABLES,
  type AccountPlan,
  type EnvironmentSnapshot,
  type MatchesFingerprint,
  type RemoveBatchResult,
  type SeedAccountsResult,
} from './demo-seed.js';

/**
 * Informes de la carga de demo. Pensados para pegar en el ticket: sólo cantidades y huellas. Nunca
 * incluyen contraseñas, correos, identificadores de cuentas ni la dirección del proyecto de Supabase.
 */

/** Huella corta del host de Supabase: identifica la base sin mostrar el identificador del proyecto. */
export function hostFingerprint(host: string): string {
  return createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 12);
}

function matchesLine(matches: MatchesFingerprint): string {
  const states = Object.entries(matches.byStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');

  return `${matches.count} partidos (${states}); primero ${matches.firstKickoff ?? '-'}, último ${matches.lastKickoff ?? '-'}; huella ${matches.digest.slice(0, 16)}`;
}

export function formatSnapshot(title: string, snapshot: EnvironmentSnapshot): string {
  const lines = [
    `== ${title} ==`,
    'Cuentas y perfiles (se presentan por separado):',
    `  cuentas registradas (con correo, no anónimas): ${snapshot.registeredAccounts}`,
    `  usuarios anónimos (no cuentan):                ${snapshot.anonymousUsers}`,
    `  perfiles:                                      ${snapshot.profiles}`,
    `  cuentas registradas con perfil asociado:       ${snapshot.accountsWithProfile}`,
    `  perfiles sueltos (sin cuenta registrada):      ${snapshot.strayProfiles}`,
    `  cuentas de este lote / con perfil:             ${snapshot.batchAccounts} / ${snapshot.batchAccountsWithProfile}`,
    'Conteo por tabla principal:',
    ...COUNTED_TABLES.map((table) => `  ${table.padEnd(24)} ${snapshot.tables[table]}`),
    `Partidos: ${matchesLine(snapshot.matches)}`,
  ];

  return lines.join('\n');
}

export function formatPlan(plan: AccountPlan): string {
  return [
    '== Plan de cuentas ==',
    `  mínimo pedido:                               ${plan.target}`,
    `  cuentas con perfil que ya aporta el entorno: ${plan.existingOutsideBatch}`,
    `  cuentas del lote necesarias:                 ${plan.needed}`,
    `  (de ellas, masivas: ${plan.bulkTarget}; de demostración: ${plan.needed - plan.bulkTarget})`,
  ].join('\n');
}

export function formatSeedResult(result: SeedAccountsResult): string {
  const lines = [
    '== Resultado de la carga de cuentas ==',
    `  cuentas creadas:      ${result.createdAccounts}`,
    `  ya existían:          ${result.existingAccounts}`,
    `  perfiles creados:     ${result.createdProfiles}`,
    `  correos en conflicto: ${result.conflicts} (de otra persona: no se tocaron)`,
    `  fallos:               ${result.failures.length}`,
    ...result.failures.slice(0, 20).map((failure) => `    - ${failure.ref}: ${failure.reason}`),
  ];

  if (result.failures.length > 20) {
    lines.push(`    … y ${result.failures.length - 20} más`);
  }

  return lines.join('\n');
}

export function formatRemoval(result: RemoveBatchResult, apply: boolean): string {
  return [
    apply
      ? '== Retirada del lote (aplicada) =='
      : '== Retirada del lote (simulacro: no se borró nada) ==',
    `  cuentas del lote:                    ${result.batchAccounts}`,
    `  cuentas que se conservan:            ${result.retainedAccounts}`,
    `  comentarios a borrar / conservados:  ${result.removableComments} / ${result.blockedComments}`,
    ...Object.entries(result.deleted).map(
      ([table, count]) => `  borrado de ${table.padEnd(24)} ${count}`,
    ),
  ].join('\n');
}

/** Compara antes y después: qué cambió y si los partidos quedaron intactos. */
export function formatComparison(before: EnvironmentSnapshot, after: EnvironmentSnapshot): string {
  const rows: [string, number, number][] = [
    ['cuentas registradas', before.registeredAccounts, after.registeredAccounts],
    ['perfiles', before.profiles, after.profiles],
    ['cuentas registradas con perfil', before.accountsWithProfile, after.accountsWithProfile],
    ...COUNTED_TABLES.map((table): [string, number, number] => [
      table,
      before.tables[table],
      after.tables[table],
    ]),
  ];
  const unchanged = before.matches.digest === after.matches.digest;

  return [
    '== Antes / después ==',
    ...rows.map(
      ([name, was, now]) =>
        `  ${name.padEnd(34)} ${String(was).padStart(6)} → ${String(now).padStart(6)}  (${now - was >= 0 ? '+' : ''}${now - was})`,
    ),
    `  Partidos: ${
      unchanged
        ? `idénticos (mismos ids, fechas y estados; huella ${after.matches.digest.slice(0, 16)})`
        : 'CAMBIARON: revisar (¿corrió la sincronización diaria durante la carga?)'
    }`,
  ].join('\n');
}
