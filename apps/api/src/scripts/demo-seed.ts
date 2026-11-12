import { URL } from 'node:url';
import {
  DEFAULT_BATCH_ID,
  checkMinimum,
  planAccounts,
  RemovalDisabledError,
  removeBatch,
  seedAccounts,
  takeSnapshot,
  TARGET_REGISTERED_ACCOUNTS,
  type DemoSeedConfig,
} from '../modules/demo-seed/application/demo-seed.js';
import { seedDemoActivity } from '../modules/demo-seed/application/demo-activity.js';
import {
  formatComparison,
  formatMinimum,
  formatPlan,
  formatRemoval,
  formatSeedResult,
  formatSnapshot,
  hostFingerprint,
} from '../modules/demo-seed/application/demo-seed-report.js';

/**
 * Carga administrativa del entorno de demo (Challenge Sorpresa 2): al menos 501 cuentas registradas
 * con su perfil, dos cuentas de demostración y una muestra de actividad coherente. Corre del lado
 * servidor con la service_role key; nada de esto llega al frontend ni al repositorio.
 *
 *   pnpm --filter @watchparty/api demo:seed -- plan      # solo lectura: conteos, plan y candidatos
 *   pnpm --filter @watchparty/api demo:seed -- apply     # crea lo que falta (idempotente)
 *   pnpm --filter @watchparty/api demo:seed -- report    # conteos actuales
 *   pnpm --filter @watchparty/api demo:seed -- remove            # simulacro de retirada del lote
 *   (`remove --apply`, la retirada efectiva, está DESHABILITADA: ver el runbook)
 *
 * Variables (ver docs/runbooks/demo-501-usuarios.md): `DEMO_ENV_LABEL`, `DEMO_EXPECTED_SUPABASE_HOST`
 * (guarda contra correr sobre la base equivocada), las credenciales de las dos cuentas de
 * demostración y, para la actividad, `DEMO_MATCH_IDS`. Códigos de salida: 0 todo bien, 1 hubo
 * fallos (volver a correr retoma), 2 configuración inválida.
 */
const COMMANDS = ['plan', 'apply', 'report', 'remove'] as const;
type Command = (typeof COMMANDS)[number];

const REQUIRED_ALWAYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WEB_ORIGIN',
  'DEMO_ENV_LABEL',
  'DEMO_EXPECTED_SUPABASE_HOST',
] as const;
const REQUIRED_FOR_APPLY = [
  'DEMO_ACCOUNT_A_EMAIL',
  'DEMO_ACCOUNT_A_PASSWORD',
  'DEMO_ACCOUNT_B_EMAIL',
  'DEMO_ACCOUNT_B_PASSWORD',
] as const;
const MIN_DEMO_PASSWORD_LENGTH = 12;

function configError(message: string): never {
  console.error(message);
  process.exit(2);
}

function readEnvList(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());

  if (missing.length > 0) {
    configError(`Faltan variables de entorno: ${missing.join(', ')}.`);
  }
}

function parseArgs(argv: string[]): { command: Command; apply: boolean; limit?: number } {
  const [command, ...flags] = argv.filter((arg) => arg !== '--');

  if (!COMMANDS.includes(command as Command)) {
    configError(`Comando inválido. Usá uno de: ${COMMANDS.join(', ')}.`);
  }

  const limitFlag = flags.find((flag) => flag.startsWith('--limit='));
  const limit = limitFlag ? Number(limitFlag.slice('--limit='.length)) : undefined;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    configError('--limit tiene que ser un entero mayor o igual a 0.');
  }

  return { command: command as Command, apply: flags.includes('--apply'), limit };
}

async function main(): Promise<void> {
  const { command, apply, limit } = parseArgs(process.argv.slice(2));

  readEnvList(REQUIRED_ALWAYS);
  if (command === 'apply') readEnvList(REQUIRED_FOR_APPLY);

  const host = new URL(process.env.SUPABASE_URL!).host;
  if (host !== process.env.DEMO_EXPECTED_SUPABASE_HOST!.trim()) {
    configError(
      'SUPABASE_URL no coincide con DEMO_EXPECTED_SUPABASE_HOST: no se corre sobre una base que no se confirmó.',
    );
  }

  const passwords = [process.env.DEMO_ACCOUNT_A_PASSWORD, process.env.DEMO_ACCOUNT_B_PASSWORD];
  if (
    command === 'apply' &&
    passwords.some((password) => (password ?? '').length < MIN_DEMO_PASSWORD_LENGTH)
  ) {
    configError(
      `Las contraseñas de demostración tienen que tener al menos ${MIN_DEMO_PASSWORD_LENGTH} caracteres.`,
    );
  }

  const batchId = process.env.DEMO_BATCH_ID?.trim() || DEFAULT_BATCH_ID;
  const config: DemoSeedConfig = {
    batchId,
    targetAccounts: TARGET_REGISTERED_ACCOUNTS,
    emailDomain: process.env.DEMO_EMAIL_DOMAIN?.trim() || 'demo.watchparty.local',
    demoAccounts: [
      {
        email: process.env.DEMO_ACCOUNT_A_EMAIL?.trim() ?? '',
        password: process.env.DEMO_ACCOUNT_A_PASSWORD ?? '',
        displayName: 'Valentina Ríos',
        bio: 'Hincha de toda la vida. Los domingos no se negocian.',
      },
      {
        email: process.env.DEMO_ACCOUNT_B_EMAIL?.trim() ?? '',
        password: process.env.DEMO_ACCOUNT_B_PASSWORD ?? '',
        displayName: 'Mateo Sosa',
        bio: 'Veo todos los partidos que puedo, aunque sea en el celu.',
      },
    ],
    limit: limit ?? (process.env.DEMO_SEED_LIMIT ? Number(process.env.DEMO_SEED_LIMIT) : undefined),
  };

  // Recién acá se carga `config/env`: exige las variables que ya se comprobaron arriba.
  const { createSupabaseSportsDataClient } =
    await import('../modules/matches/infrastructure/supabase-sports-data-client.js');
  const { SupabaseMatchStore } =
    await import('../modules/matches/infrastructure/supabase-match-store.js');
  const { SupabaseDemoSeedGateway } =
    await import('../modules/demo-seed/infrastructure/supabase-demo-seed-gateway.js');
  const client = createSupabaseSportsDataClient();
  const gateway = new SupabaseDemoSeedGateway(client);
  const catalog = new SupabaseMatchStore(client);

  console.log(`Entorno: ${process.env.DEMO_ENV_LABEL}`);
  console.log(`Base (huella del host): ${hostFingerprint(host)}`);
  if (process.env.DEMO_WEB_URL) console.log(`Web: ${process.env.DEMO_WEB_URL}`);
  console.log(`Fecha: ${new Date().toISOString()}`);
  console.log(`Lote: ${batchId}\n`);

  if (command === 'remove') {
    if (apply && !gateway.atomicCommentRemoval) {
      // La retirada efectiva no es segura frente a reacciones concurrentes: no se escribe nada.
      configError(new RemovalDisabledError().message);
    }

    const result = await removeBatch(gateway, batchId, { apply });
    console.log(formatRemoval(result, apply));
    if (!apply) {
      console.log('\nEs un simulacro: no se borró nada. La retirada efectiva está deshabilitada.');
    }
    return;
  }

  const before = await takeSnapshot(gateway, batchId);
  console.log(formatSnapshot('Antes', before));

  if (command === 'report') return;

  const plan = planAccounts(before, config);
  console.log(`\n${formatPlan(plan)}`);

  if (command === 'plan') {
    const candidates = await gateway.listFinishedMatchCandidates(10);
    console.log(
      '\n== Partidos finalizados candidatos para DEMO_MATCH_IDS (los 10 más recientes) ==',
    );
    for (const match of candidates) {
      console.log(`  ${match.id}  ${match.kickoffAt.slice(0, 10)}  ${match.home} vs ${match.away}`);
    }
    return;
  }

  const [{ SupabaseOwnProfileStore }, ...stores] = await Promise.all([
    import('../modules/profiles/infrastructure/supabase-own-profile-store.js'),
    import('../modules/rooms/infrastructure/supabase-public-room-store.js'),
    import('../modules/comments/infrastructure/supabase-room-comment-store.js'),
    import('../modules/comments/infrastructure/supabase-room-comment-reaction-store.js'),
    import('../modules/watched/infrastructure/supabase-watched-match-store.js'),
    import('../modules/ratings/infrastructure/supabase-match-rating-store.js'),
    import('../modules/reviews/infrastructure/supabase-match-review-store.js'),
    import('../modules/ratings/application/match-rating-service.js'),
    import('../modules/reviews/application/match-review-service.js'),
  ]);
  const [rooms, comments, reactions, watched, ratings, reviews, ratingService, reviewService] =
    stores;

  const profiles = new SupabaseOwnProfileStore(client);
  const accounts = await seedAccounts({ gateway, profiles }, config, plan);
  console.log(`\n${formatSeedResult(accounts)}`);

  let failures = accounts.failures.length;
  const matchIds = (process.env.DEMO_MATCH_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const [userA, userB] = accounts.demoUserIds;

  if (matchIds.length === 0) {
    console.log('\nActividad: omitida (definí DEMO_MATCH_IDS con los partidos elegidos).');
  } else if (!userA || !userB) {
    console.log('\nActividad: omitida porque falta alguna cuenta de demostración.');
    failures += 1;
  } else {
    const watchedStore = new watched.SupabaseWatchedMatchStore(client, catalog);
    const ratingStore = new ratings.SupabaseMatchRatingStore(client);
    const activity = await seedDemoActivity(
      {
        catalog,
        rooms: new rooms.SupabasePublicRoomStore(client, catalog),
        comments: new comments.SupabaseRoomCommentStore(client),
        reactions: new reactions.SupabaseRoomCommentReactionStore(client),
        watched: watchedStore,
        ratings: new ratingService.MatchRatingService(catalog, watchedStore, ratingStore),
        reviews: new reviewService.MatchReviewService(
          catalog,
          watchedStore,
          ratingStore,
          new reviews.SupabaseMatchReviewStore(client),
        ),
      },
      batchId,
      [userA, userB],
      matchIds,
    );

    console.log('\n== Actividad de demostración ==');
    for (const match of activity.matches) {
      console.log(
        `  partido ${match.matchId}: sala ${match.roomId}, ${match.comments} comentarios`,
      );
    }
    for (const failure of activity.failures) console.log(`  fallo: ${failure}`);
    failures += activity.failures.length;
  }

  const after = await takeSnapshot(gateway, batchId);
  console.log(`\n${formatSnapshot('Después', after)}`);
  console.log(`\n${formatComparison(before, after)}`);

  // El mínimo se verifica al terminar una corrida completa: no alcanzarlo es un error explícito,
  // aunque ninguna cuenta haya fallado. Una corrida limitada a propósito no se juzga.
  const minimum = checkMinimum(after, config);
  console.log(`\n${formatMinimum(minimum)}`);

  if (minimum.checked && !minimum.reached) {
    console.error(
      `\nERROR: la carga terminó con ${minimum.accountsWithProfile} cuentas registradas con perfil y el mínimo es ${minimum.target}. Revisar los fallos y volver a correr \`apply\`.`,
    );
    process.exitCode = 1;
  }

  if (failures > 0) {
    console.error(
      `\n${failures} fallo(s). Volver a correr \`apply\` retoma lo que quedó a medias.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // El mensaje puede traer un correo de una cuenta: se tapa antes de mostrarlo.
  const message = error instanceof Error ? error.message : 'error desconocido';
  console.error(
    'La carga se interrumpió:',
    message.replace(/[^\s@]+@[^\s@]+/g, '[correo]').slice(0, 200),
  );
  process.exitCode = 1;
});
