import { describe, it, expect } from 'vitest';
import request from 'supertest';

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
