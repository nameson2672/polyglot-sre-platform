import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

async function requestIdPluginImpl(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    const existing = req.headers['x-request-id'];
    if (existing && typeof existing === 'string') {
      req.id = existing;
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    return payload;
  });
}

export const requestIdPlugin = fp(requestIdPluginImpl, {
  name: 'request-id',
});
