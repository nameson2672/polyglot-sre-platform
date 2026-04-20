import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { checkoutRoutes } from '../routes/v1/checkout.js';
import { jwtStubPlugin } from '../plugins/jwtStub.js';

// Mocks
vi.mock('../clients/ordersApi.js', () => ({
  createOrder: vi.fn(),
  listOrders: vi.fn(),
  getOrderById: vi.fn(),
  pool: { close: vi.fn(), request: vi.fn() },
  OrdersApiError: class OrdersApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.name = 'OrdersApiError';
      this.statusCode = statusCode;
    }
  },
}));

vi.mock('../clients/paymentStub.js', () => ({
  processPayment: vi
    .fn()
    .mockResolvedValue({ transactionId: 'txn_test', processingTimeMs: 100 }),
  PaymentFailedError: class PaymentFailedError extends Error {
    constructor(msg = 'Payment declined') {
      super(msg);
      this.name = 'PaymentFailedError';
    }
  },
}));

vi.mock('../lib/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
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

const DEV_JWT = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ customer_id: '00000000-0000-0000-0000-000000000001' }),
  ).toString('base64url');
  return `${header}.${payload}.fake-sig`;
})();

const CHECKOUT_BODY = {
  items: [{ sku: 'ABC', qty: 1, unit_price_cents: 1000 }],
  payment_method: 'card_stub',
};

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(jwtStubPlugin);
  app.register(checkoutRoutes, { prefix: '/v1' });
  return app;
}

describe('POST /v1/checkout', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('happy path returns 201 with order_id', async () => {
    const { createOrder } = await import('../clients/ordersApi.js');
    vi.mocked(createOrder).mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      customer_id: '00000000-0000-0000-0000-000000000001',
      status: 'pending',
      total_cents: 1000,
      currency: 'USD',
      items: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEV_JWT}`,
        'idempotency-key': '22222222-2222-2222-2222-222222222222',
      },
      body: JSON.stringify(CHECKOUT_BODY),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.status).toBe('confirmed');
  });

  it('returns 400 when Idempotency-Key is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEV_JWT}`,
      },
      body: JSON.stringify(CHECKOUT_BODY),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 402 when payment stub fails', async () => {
    const { processPayment, PaymentFailedError } = await import('../clients/paymentStub.js');
    vi.mocked(processPayment).mockRejectedValueOnce(new PaymentFailedError('Payment declined'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEV_JWT}`,
        'idempotency-key': '33333333-3333-3333-3333-333333333333',
      },
      body: JSON.stringify(CHECKOUT_BODY),
    });

    expect(res.statusCode).toBe(402);
  });

  it('returns 503 when orders-api returns 5xx after retries', async () => {
    const { createOrder, OrdersApiError } = await import('../clients/ordersApi.js');
    vi.mocked(createOrder).mockRejectedValueOnce(new OrdersApiError(503, 'Service Unavailable'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEV_JWT}`,
        'idempotency-key': '44444444-4444-4444-4444-444444444444',
      },
      body: JSON.stringify(CHECKOUT_BODY),
    });

    expect(res.statusCode).toBe(503);
  });

  it('returns 400 when body validation fails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEV_JWT}`,
        'idempotency-key': '55555555-5555-5555-5555-555555555555',
      },
      body: JSON.stringify({ items: [] }), // empty items fails zod min(1)
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/checkout/:sessionId', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 for unknown session', async () => {
    const { cacheGet } = await import('../lib/cache.js');
    vi.mocked(cacheGet).mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/checkout/nonexistent-id',
      headers: { authorization: `Bearer ${DEV_JWT}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with cached session', async () => {
    const { cacheGet } = await import('../lib/cache.js');
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify({
        checkout_id: 'abc',
        order_id: '11111111-1111-1111-1111-111111111111',
        status: 'confirmed',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/checkout/abc',
      headers: { authorization: `Bearer ${DEV_JWT}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('confirmed');
  });
});
