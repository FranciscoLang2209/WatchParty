type WebEnvName = 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY' | 'VITE_API_BASE_URL';

export interface WebEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiBaseUrl: string;
}

function requireEnv(name: WebEnvName): string {
  const value = import.meta.env[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Falta la variable de entorno ${name}. Copiar apps/web/.env.example a .env.`);
  }

  return value;
}

export function readWebEnv(): WebEnv {
  return {
    supabaseUrl: requireEnv('VITE_SUPABASE_URL'),
    supabaseAnonKey: requireEnv('VITE_SUPABASE_ANON_KEY'),
    apiBaseUrl: requireEnv('VITE_API_BASE_URL'),
  };
}
