import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface JwtPayload {
  customer_id: string;
  iat?: number;
  exp?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    jwtPayload?: JwtPayload;
    customerId?: string;
  }
}

async function jwtStubPluginImpl(app: FastifyInstance): Promise<void> {
  app.decorateRequest<JwtPayload | undefined>('jwtPayload', undefined);
  app.decorateRequest<string | undefined>('customerId', undefined);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return;
    const token = auth.slice(7);
    try {
      const parts = token.split('.');
      const payloadB64 = parts[1];
      if (!payloadB64) return;
      const payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      ) as JwtPayload;
      req.jwtPayload = payload;
      req.customerId = payload.customer_id;
    } catch {
      // ignore invalid JWT in dev
    }
  });
}

export const jwtStubPlugin = fp(jwtStubPluginImpl, {
  name: 'jwt-stub',
});
