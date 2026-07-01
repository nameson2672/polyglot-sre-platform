import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

// The chaos plugin reads CHAOS_ERROR_RATE at registration time from config, so
// each test sets the mocked value before dynamically importing the plugin.
const configMock = { CHAOS_ERROR_RATE: 0 };
vi.mock('../config.js', () => ({ config: configMock }));

async function buildApp(rate: number) {
  configMock.CHAOS_ERROR_RATE = rate;
  vi.resetModules();
  const { chaosPlugin } = await import('../plugins/chaos.js');
  const app = Fastify({ logger: false });
  await app.register(chaosPlugin);
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.post('/v1/checkout', async (_req, reply) => reply.status(201).send({ ok: true }));
  return app;
}

describe('chaos plugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rate=0 never injects 500s', async () => {
    const app = await buildApp(0);
    vi.spyOn(Math, 'random').mockReturnValue(0); // would trip if the hook were active
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/checkout' });
      expect(res.statusCode).toBe(201);
    }
    await app.close();
  });

  it('rate=1 injects 500 on a business route', async () => {
    const app = await buildApp(1);
    const res = await app.inject({ method: 'POST', url: '/v1/checkout' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).title).toBe('Injected Server Error');
    await app.close();
  });

  it('never injects on probe/scrape paths even at rate=1', async () => {
    const app = await buildApp(1);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
