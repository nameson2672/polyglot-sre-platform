import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import { config } from './config.js';
import { requestIdPlugin } from './plugins/requestId.js';
import { jwtStubPlugin } from './plugins/jwtStub.js';
import { metricsPlugin } from './plugins/metrics.js';
import { problemDetailsPlugin } from './plugins/problemDetails.js';
import { healthRoutes, setShuttingDown } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { checkoutRoutes } from './routes/v1/checkout.js';
import { customerRoutes } from './routes/v1/customer.js';
import { appInfo } from './lib/metrics.js';
import { closeRedis } from './lib/cache.js';
import { sdk } from './telemetry.js';
import { pool } from './clients/ordersApi.js';

function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.APP_ENV === 'dev'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: false,
  });

  return app;
}

export async function start(): Promise<void> {
  const app = buildApp();

  // Plugin registration ORDER IS CRITICAL
  await app.register(helmet);
  await app.register(cors);
  await app.register(sensible);
  await app.register(requestIdPlugin);
  await app.register(jwtStubPlugin);
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    message: 'Under pressure!',
    retryAfter: 50,
  });
  await app.register(metricsPlugin);
  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(checkoutRoutes, { prefix: '/v1' });
  await app.register(customerRoutes, { prefix: '/v1' });
  await problemDetailsPlugin(app);

  // Boot metrics
  appInfo.set(
    {
      version: config.SERVICE_VERSION,
      commit: config.SERVICE_COMMIT,
      service: 'checkout-bff',
    },
    1,
  );

  // SIGTERM graceful shutdown
  process.on('SIGTERM', async () => {
    app.log.info('SIGTERM received — starting graceful shutdown');
    setShuttingDown();

    const forceExit = setTimeout(() => {
      app.log.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    try {
      await app.close();
      await closeRedis();
      await pool.close();
      await sdk.shutdown();
      app.log.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });

  await app.listen({ port: config.CHECKOUT_BFF_PORT, host: '0.0.0.0' });
  app.log.info(`checkout-bff listening on :${config.CHECKOUT_BFF_PORT}`);
}
