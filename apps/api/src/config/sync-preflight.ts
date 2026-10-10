/**
 * Preflight de entorno del comando `matches:sync` (WAT-186).
 *
 * Valida TODAS las variables requeridas antes de consultar al proveedor o
 * escribir en la base, y reporta juntas las que faltan o son inválidas. Nunca
 * incluye valores en los mensajes (solo nombres y motivos), así que una
 * credencial no puede filtrarse por un log.
 *
 * Es agnóstico del proveedor: `checkSyncEnv` recibe la lista de requisitos por
 * parámetro. Los grupos de Supabase y de cada proveedor viven en listas
 * separadas porque sus credenciales son independientes, y solo se exigen las del
 * proveedor seleccionado (nunca se piden las de ambos).
 */
import type { SyncProviderName } from './sports-provider-env.js';

export interface EnvRequirement {
  name: string;
  /** Devuelve el motivo del rechazo (sin incluir el valor) o `null` si es válido. */
  validate?: (value: string) => string | null;
}

export interface InvalidEnvVar {
  name: string;
  reason: string;
}

export type SyncPreflightResult =
  { ok: true } | { ok: false; missing: string[]; invalid: InvalidEnvVar[]; message: string };

const URL_REASON = 'debe ser una URL http(s) válida';

export function httpUrl(value: string): string | null {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? null : URL_REASON;
  } catch {
    return URL_REASON;
  }
}

/**
 * Requisitos de Supabase (destino de producción). `SUPABASE_ANON_KEY` y
 * `WEB_ORIGIN` figuran porque `config/env.ts` las exige al importarse, aunque
 * la sincronización no las use.
 */
export const SUPABASE_ENV_REQUIREMENTS: readonly EnvRequirement[] = [
  { name: 'SUPABASE_URL', validate: httpUrl },
  { name: 'SUPABASE_SERVICE_ROLE_KEY' },
  { name: 'SUPABASE_ANON_KEY' },
  { name: 'WEB_ORIGIN' },
];

export const FOOTBALL_DATA_ORG_ENV_REQUIREMENTS: readonly EnvRequirement[] = [
  { name: 'FOOTBALL_DATA_ORG_BASE_URL', validate: httpUrl },
  { name: 'FOOTBALL_DATA_ORG_API_KEY' },
];

export const API_FOOTBALL_ENV_REQUIREMENTS: readonly EnvRequirement[] = [
  { name: 'API_FOOTBALL_BASE_URL', validate: httpUrl },
  { name: 'API_FOOTBALL_KEY' },
];

/** Requisitos de una corrida: Supabase más SOLO las credenciales del proveedor elegido. */
export function syncEnvRequirements(provider: SyncProviderName): readonly EnvRequirement[] {
  return [
    ...SUPABASE_ENV_REQUIREMENTS,
    ...(provider === 'api-football'
      ? API_FOOTBALL_ENV_REQUIREMENTS
      : FOOTBALL_DATA_ORG_ENV_REQUIREMENTS),
  ];
}

export function checkSyncEnv(
  env: NodeJS.ProcessEnv,
  requirements: readonly EnvRequirement[],
): SyncPreflightResult {
  const missing: string[] = [];
  const invalid: InvalidEnvVar[] = [];

  for (const { name, validate } of requirements) {
    // Las credenciales de backend nunca pueden viajar en variables del bundle frontend.
    if (name.startsWith('VITE_')) {
      throw new Error(`El requisito ${name} es inválido: las credenciales no pueden ser VITE_*.`);
    }

    const value = env[name]?.trim();

    if (!value) {
      missing.push(name);
      continue;
    }

    const reason = validate?.(value);

    if (reason) {
      invalid.push({ name, reason });
    }
  }

  if (missing.length === 0 && invalid.length === 0) {
    return { ok: true };
  }

  const lines = ['Configuración de sincronización incompleta o inválida.'];

  if (missing.length > 0) {
    lines.push(`Faltan: ${missing.join(', ')}`);
  }

  if (invalid.length > 0) {
    lines.push(`Inválidas: ${invalid.map(({ name, reason }) => `${name} (${reason})`).join(', ')}`);
  }

  return { ok: false, missing, invalid, message: lines.join('\n') };
}
