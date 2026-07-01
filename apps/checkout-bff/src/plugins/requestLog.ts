import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { isExemptPath } from '../lib/paths.js';

// Policy: errors + business events only. Fastify's automatic per-request access
// log is disabled (disableRequestLogging: true) — request rate/latency/errors
// are tracked as metrics, not logs. This hook emits ONE structured line per
// failed request (4xx warn / 5xx error), skipping probe/scrape paths so healthy
// probes stay silent. Successful business requests log their own domain event.
async function requestLogPluginImpl(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode;
    if (status < 400 || isExemptPath(req.url)) {
      return;
    }
    const fields = {
      method: req.method,
      url: req.url,
      statusCode: status,
      requestId: req.id,
      responseTimeMs: Math.round(reply.elapsedTime),
    };
    // 5xx from a thrown error is additionally logged with its stack by the
    // problemDetails error handler; this line is the concise request outcome.
    if (status >= 500) {
      req.log.error(fields, 'request failed');
    } else {
      req.log.warn(fields, 'request failed');
    }
  });
}

export const requestLogPlugin = fp(requestLogPluginImpl, {
  name: 'requestLog',
});
