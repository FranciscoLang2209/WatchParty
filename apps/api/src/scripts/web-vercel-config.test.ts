import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

interface VercelConfig {
  rewrites?: { source: string; destination: string }[];
}

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../web/vercel.json', import.meta.url)), 'utf8'),
) as VercelConfig;

describe('vercel.json de la web', () => {
  // Sin este fallback, abrir `/reset-password` (el destino del enlace del correo) o recargar
  // cualquier ruta que no sea la raíz devuelve el 404 de Vercel y la app nunca llega a cargar.
  it('devuelve index.html para cualquier ruta, así el enrutador del cliente la resuelve', () => {
    expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });
});
