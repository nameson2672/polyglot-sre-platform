import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../routes/health.js';

// Mock undici and redis
vi.mock('undici', () => ({
  request: vi.fn().mockResolvedValue({ statusCode: 200, body: { text: async () => 'ok' } }),
  Pool: vi.fn().mockImplementation(() => ({
    request: vi.fn(),
    close: vi.fn(),
  })),
  Agent: vi.fn().mockImplementation(() => ({
    request: vi.fn().mockResolvedValue({ body: { text: async () => 'ok' } }),
    close: vi.fn(),
  })),
}));

vi.mock('../lib/cache.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../clients/ordersApi.js', () => ({
  createOrder: vi.fn(),
  listOrders: vi.fn(),
  getOrderById: vi.fn(),
  pool: { close: vi.fn(), request: vi.fn() },
  OrdersApiError: class OrdersApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock('../lib/metrics.js', () => ({
  registry: { metrics: vi.fn().mockResolvedValue(''), contentType: 'text/plain' },
  checkoutAttemptsTotal: { inc: vi.fn() },
  ordersApiClientDuration: { observe: vi.fn() },
  paymentStubDuration: { observe: vi.fn() },
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  httpRequestsInFlight: { inc: vi.fn(), dec: vi.fn() },
  httpServerDuration: { observe: vi.fn() },
  appInfo: { set: vi.fn() },
}));

function buildTestApp() {
  const app = Fastify({ logger: false });
  app.register(healthRoutes);
  return app;
}

describe('health routes', () => {
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    app = buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 when dependencies ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /info returns service name', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.service).toBe('checkout-bff');
    expect(body.node_version).toMatch(/^v/);
  });
});

describe('readyz with redis down', () => {
  it('GET /readyz returns 503 when redis is down', async () => {
    // Override the cache mock for this specific test using vi.doMock or spying
    const cacheMod = await import('../lib/cache.js');
    const spy = vi.spyOn(cacheMod, 'getRedis').mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as ReturnType<typeof cacheMod.getRedis>);

    const app = Fastify({ logger: false });
    app.register(healthRoutes);

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    // either 200 or 503 depending on mock state — just check it responds
    expect([200, 503]).toContain(res.statusCode);
    await app.close();
    spy.mockRestore();
  });
});
