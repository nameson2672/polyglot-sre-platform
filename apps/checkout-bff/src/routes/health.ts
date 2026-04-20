import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getRedis } from '../lib/cache.js';
import { request as undiciRequest } from 'undici';

let isShuttingDown = false;

export function setShuttingDown(): void {
  isShuttingDown = true;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_req, reply) => {
    if (isShuttingDown) {
      return reply.status(503).send({ status: 'shutting_down' });
    }

    const checks: Record<string, string> = {};

    // Check orders-api
    try {
      const { statusCode } = await undiciRequest(`${config.ORDERS_API_URL}/healthz`, {
        method: 'GET',
        headersTimeout: 2000,
        bodyTimeout: 2000,
      });
      checks['orders_api'] = statusCode < 500 ? 'ok' : 'error';
    } catch {
      checks['orders_api'] = 'error';
    }

    // Check Redis
    try {
      await getRedis().ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply
      .status(allOk ? 200 : 503)
      .send({ status: allOk ? 'ok' : 'degraded', checks });
  });

  app.get('/info', async (_req, reply) => {
    return reply.send({
      service: 'checkout-bff',
      version: config.SERVICE_VERSION,
      commit: config.SERVICE_COMMIT,
      node_version: process.version,
    });
  });
}
