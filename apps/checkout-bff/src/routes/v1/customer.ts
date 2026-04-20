import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { listOrders } from '../../clients/ordersApi.js';
import { cacheGet, cacheSet } from '../../lib/cache.js';
import { cacheHitsTotal, cacheMissesTotal } from '../../lib/metrics.js';
import { PaginationSchema } from '../../schemas/common.js';

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/customer/orders', async (req: FastifyRequest, reply: FastifyReply) => {
    const customerId = req.customerId;
    if (!customerId) {
      return reply
        .status(401)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://problems.checkout-bff/unauthorized',
          title: 'Authentication required',
          status: 401,
          instance: req.url,
        });
    }

    const query = PaginationSchema.parse(req.query);
    const cacheKey = `customer:${customerId}:orders:page=${query.page}:size=${query.size}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      cacheHitsTotal.inc();
      req.log.info({ customer_id: customerId, cache: 'hit' }, 'Cache hit for customer orders');
      return reply.header('x-cache', 'HIT').send(JSON.parse(cached));
    }

    cacheMissesTotal.inc();
    req.log.info(
      { customer_id: customerId, cache: 'miss' },
      'Cache miss for customer orders',
    );

    const headers = {
      traceparent: req.headers['traceparent'] as string | undefined,
      'x-request-id': req.id,
    };

    const result = await listOrders(customerId, query.page, query.size, headers);
    await cacheSet(cacheKey, JSON.stringify(result), 30);

    return reply.header('x-cache', 'MISS').send(result);
  });
}
