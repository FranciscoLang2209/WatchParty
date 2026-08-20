import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './app.js';

describe('GET /health', () => {
  //seria como la carpeta de los tests cases
  it('responde 200 con { status: "ok" }', async () => {
    // Seria como un archivo dentro de esta carpeta con el nombre del test case
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
