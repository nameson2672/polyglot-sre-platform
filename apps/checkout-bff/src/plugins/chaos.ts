import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// Probe and scrape paths must stay healthy so Kubernetes keeps the pod in the
// Service and Prometheus keeps scraping — otherwise the canary would fail the
// readiness gate instead of the AnalysisRun, which defeats the demo.
const EXEMPT_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

async function chaosPluginImpl(app: FastifyInstance): Promise<void> {
  if (config.CHAOS_ERROR_RATE <= 0) {
    // Zero-cost in the common case: don't even register the hook.
    return;
  }

  app.log.warn(
    { chaosErrorRate: config.CHAOS_ERROR_RATE },
    'CHAOS injection enabled — returning synthetic 500s',
  );

  app.addHook('onRequest', async (req, reply) => {
    if (EXEMPT_PATHS.has(req.url.split('?')[0]!)) {
      return;
    }
    if (Math.random() < config.CHAOS_ERROR_RATE) {
      return reply
        .status(500)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://problems.checkout-bff/chaos-injection',
          title: 'Injected Server Error',
          status: 500,
          detail: 'Synthetic 500 injected by CHAOS_ERROR_RATE',
          instance: req.url,
        });
    }
  });
}

export const chaosPlugin = fp(chaosPluginImpl, {
  name: 'chaos',
});
