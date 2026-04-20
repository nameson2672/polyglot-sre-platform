import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { customerRoutes } from '../routes/v1/customer.js';
import { jwtStubPlugin } from '../plugins/jwtStub.js';

vi.mock('../clients/ordersApi.js', () => ({
  createOrder: vi.fn(),
  listOrders: vi.fn().mockResolvedValue({
    total: 1,
    page: 1,
    page_size: 20,
    items: [{ id: 'order-1', status: 'pending' }],
  }),
  getOrderById: vi.fn(),
  pool: { close: vi.fn(), request: vi.fn() },
  OrdersApiError: class extends Error {
    statusCode: number;
    constructor(s: number, m: string) {
      super(m);
      this.statusCode = s;
    }
  },
}));

vi.mock('../lib/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  closeRedis: vi.fn(),
  getRedis: vi.fn(),
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

vi.mock('undici', () => ({
  request: vi.fn(),
  Pool: vi.fn().mockImplementation(() => ({ request: vi.fn(), close: vi.fn() })),
  Agent: vi.fn().mockImplementation(() => ({ request: vi.fn(), close: vi.fn() })),
}));

const DEV_JWT = (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({ customer_id: '00000000-0000-0000-0000-000000000001' }),
  ).toString('base64url');
  return `${h}.${p}.fake-sig`;
})();

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(jwtStubPlugin);
  app.register(customerRoutes, { prefix: '/v1' });
  return app;
}

describe('GET /v1/customer/orders — cache behavior', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('cache miss: calls orders-api and sets cache', async () => {
    const { cacheGet, cacheSet } = await import('../lib/cache.js');
    const { listOrders } = await import('../clients/ordersApi.js');
    vi.mocked(cacheGet).mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customer/orders?page=1&size=10',
      headers: { authorization: `Bearer ${DEV_JWT}` },
    });

    expect(res.statusCode).toBe(200);
    expect(listOrders).toHaveBeenCalledOnce();
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it('cache hit: returns cached data, does not call orders-api', async () => {
    const { cacheGet } = await import('../lib/cache.js');
    const { listOrders } = await import('../clients/ordersApi.js');
    const cachedData = { total: 1, page: 1, page_size: 10, items: [] };
    vi.mocked(cacheGet).mockResolvedValueOnce(JSON.stringify(cachedData));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customer/orders?page=1&size=10',
      headers: { authorization: `Bearer ${DEV_JWT}` },
    });

    expect(res.statusCode).toBe(200);
    expect(listOrders).not.toHaveBeenCalled();
    expect(res.headers['x-cache']).toBe('HIT');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customer/orders',
    });
    expect(res.statusCode).toBe(401);
  });

  it('cache miss increments cacheMissesTotal', async () => {
    const { cacheGet } = await import('../lib/cache.js');
    const { cacheMissesTotal } = await import('../lib/metrics.js');
    vi.mocked(cacheGet).mockResolvedValueOnce(null);

    await app.inject({
      method: 'GET',
      url: '/v1/customer/orders?page=1&size=5',
      headers: { authorization: `Bearer ${DEV_JWT}` },
    });

    expect(cacheMissesTotal.inc).toHaveBeenCalled();
  });

  it('cache hit increments cacheHitsTotal', async () => {
    const { cacheGet } = await import('../lib/cache.js');
    const { cacheHitsTotal } = await import('../lib/metrics.js');
    vi.mocked(cacheGet).mockResolvedValueOnce(JSON.stringify({ items: [] }));

    await app.inject({
      method: 'GET',
      url: '/v1/customer/orders?page=1&size=5',
      headers: { authorization: `Bearer ${DEV_JWT}` },
    });

    expect(cacheHitsTotal.inc).toHaveBeenCalled();
  });
});
