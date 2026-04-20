import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export const registry = new Registry();

export const checkoutAttemptsTotal = new Counter({
  name: 'checkout_attempts_total',
  help: 'Total checkout attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const ordersApiClientDuration = new Histogram({
  name: 'orders_api_client_duration_seconds',
  help: 'Duration of orders-api client calls',
  labelNames: ['status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

export const paymentStubDuration = new Histogram({
  name: 'payment_stub_duration_seconds',
  help: 'Duration of payment stub calls',
  labelNames: ['outcome'] as const,
  buckets: [0.1, 0.3, 0.5, 1, 2],
  registers: [registry],
});

export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total Redis cache hits',
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total Redis cache misses',
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: 'http_server_requests_in_flight',
  help: 'Current number of HTTP requests being processed',
  registers: [registry],
});

export const httpServerDuration = new Histogram({
  name: 'http_server_duration_seconds',
  help: 'Duration of HTTP server requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const appInfo = new Gauge({
  name: 'app_info',
  help: 'Application info',
  labelNames: ['version', 'commit', 'service'] as const,
  registers: [registry],
});
