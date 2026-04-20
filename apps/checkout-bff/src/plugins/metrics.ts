import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { httpRequestsInFlight, httpServerDuration } from '../lib/metrics.js';

async function metricsPluginImpl(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async () => {
    httpRequestsInFlight.inc();
  });

  app.addHook('onResponse', async (req, reply) => {
    httpRequestsInFlight.dec();
    httpServerDuration.observe(
      {
        method: req.method,
        route: req.routeOptions?.url ?? req.url,
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });
}

export const metricsPlugin = fp(metricsPluginImpl, {
  name: 'metrics',
});
