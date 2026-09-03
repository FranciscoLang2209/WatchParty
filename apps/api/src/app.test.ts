import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';
import { UnauthorizedError } from './errors/http-error.js';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.WEB_ORIGIN = 'http://localhost:5173';

const { default: app } = await import('./app.js');

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
