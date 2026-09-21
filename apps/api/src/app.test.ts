import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';
import { UnauthorizedError } from './errors/http-error.js';
import { LocalMatchCatalog } from './modules/matches/infrastructure/local-match-catalog.js';
import type { OwnProfileStore } from './modules/profiles/domain/own-profile-store.js';
import type { PublicRoomStore } from './modules/rooms/domain/public-room-store.js';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.WEB_ORIGIN = 'http://localhost:5173';

const { createApp } = await import('./app.js');

// Estos tests cubren health/CORS/contrato de errores: no ejercitan lógica
// de partidos ni de perfil, así que cualquier doble alcanza. Igual que
// LocalMatchCatalog, nunca es un fallback automático: createApp no lo elige
// por sí mismo, se lo inyectamos acá a propósito.
const noopProfileStore: OwnProfileStore = {
  getOwnProfile: async () => null,
  saveOwnProfile: async (_userId, input) => ({ ...input }),
  listTeams: async () => [],
};

const noopRoomStore: PublicRoomStore = {
  getOrCreatePublicRoom: async () => null,
  findPublicRoomById: async () => null,
};

const app = createApp(new LocalMatchCatalog(), noopProfileStore, noopRoomStore);

describe('GET /health', () => {
  //seria como la carpeta de los tests cases
  it('responde 200 con { status: "ok" }', async () => {
    // Seria como un archivo dentro de esta carpeta con el nombre del test case
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('CORS', () => {
  it('permite el origen configurado en WEB_ORIGIN', async () => {
    const response = await request(app).get('/health').set('Origin', process.env.WEB_ORIGIN!);

    expect(response.headers['access-control-allow-origin']).toBe(process.env.WEB_ORIGIN);
  });

  it('no autoriza un origen distinto', async () => {
    const response = await request(app).get('/health').set('Origin', 'http://evil.example.com');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('el preflight autoriza método GET y header Authorization', async () => {
    const response = await request(app)
      .options('/health')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization');

    expect(response.headers['access-control-allow-methods']).toContain('GET');
    expect(response.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('el preflight autoriza método PUT y header Content-Type', async () => {
    const response = await request(app)
      .options('/health')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');

    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('el preflight autoriza método POST para entrar a una sala', async () => {
    const response = await request(app)
      .options('/matches/aaa/room')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization');

    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('el preflight de PUT no autoriza un origen distinto', async () => {
    const response = await request(app)
      .options('/me/profile')
      .set('Origin', 'http://evil.example.com')
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Contrato de errores', () => {
  it('una ruta inexistente devuelve 404 con código NOT_FOUND', async () => {
    const response = await request(app).get('/no-existe');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  function buildErrorTestApp() {
    const testApp = express();

    testApp.get('/unauthorized', () => {
      throw new UnauthorizedError();
    });

    testApp.get('/boom', () => {
      throw new Error('detalle interno que nunca debe salir');
    });

    testApp.use(notFoundHandler);
    testApp.use(errorHandler);

    return testApp;
  }

  it('un error de autorización devuelve 401 con código UNAUTHORIZED', async () => {
    const response = await request(buildErrorTestApp()).get('/unauthorized');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('una excepción no controlada devuelve 500 con código INTERNAL_ERROR sin detalles internos', async () => {
    const response = await request(buildErrorTestApp()).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.message).not.toContain('detalle interno');
    expect(response.text).not.toMatch(/at .*:\d+:\d+/);
  });
});

/**
 * Contrato de despliegue (WAT-138): el preset Express de Vercel carga
 * `apps/api/src/app.js` como función serverless y exige que su `default
 * export` sea la aplicación Express ya compuesta. `server.ts` nunca se
 * ejecuta en Vercel, así que la composición de producción no puede vivir
 * solo ahí: si falta el default export, el runtime aborta con
 * "Invalid export found in module" y todas las rutas devuelven
 * 500 FUNCTION_INVOCATION_FAILED.
 */
describe('Contrato del default export para Vercel', () => {
  it('app.ts exporta por defecto una app Express invocable como handler', async () => {
    const appModule = await import('./app.js');

    expect(appModule.default).toBeTypeOf('function');
    expect(appModule.default).toHaveProperty('listen');
  });

  it('la app exportada por defecto sirve GET /health con 200', async () => {
    const { default: deployedApp } = await import('./app.js');

    const response = await request(deployedApp).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
