import os from 'node:os';
import Fastify from 'fastify';
import { pino, multistream } from 'pino';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import { context, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { config } from './config.js';
import { requestIdPlugin } from './plugins/requestId.js';
import { jwtStubPlugin } from './plugins/jwtStub.js';
import { metricsPlugin } from './plugins/metrics.js';
import { chaosPlugin } from './plugins/chaos.js';
import { problemDetailsPlugin } from './plugins/problemDetails.js';
import { healthRoutes, setShuttingDown } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { checkoutRoutes } from './routes/v1/checkout.js';
import { customerRoutes } from './routes/v1/customer.js';
import { appInfo } from './lib/metrics.js';
import { closeRedis } from './lib/cache.js';
import { sdk } from './telemetry.js';
import { pool } from './clients/ordersApi.js';

const bffOtelLogger = logs.getLogger('checkout-bff');

const BFF_LABEL_TO_SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE, debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO, warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR, fatal: SeverityNumber.FATAL,
};

const bffOtelStream = {
  write(line: string): void {
    try {
      const { level, time } = JSON.parse(line) as Record<string, unknown>;
      const lvl = typeof level === 'string' ? level : 'info';
      bffOtelLogger.emit({
        timestamp: typeof time === 'number' ? time : Date.now(),
        severityNumber: BFF_LABEL_TO_SEVERITY[lvl] ?? SeverityNumber.INFO,
        severityText: lvl.toUpperCase(),
        body: line.trimEnd(),
        context: context.active(),
      });
    } catch { /* non-JSON line — ignore */ }
  },
};

// pino-pretty is a devDependency and is absent from the production image
// (npm ci --omit=dev). Load it lazily so it is only required in dev; in
// production (APP_ENV !== 'dev') logs are plain JSON to stdout.
const bffConsoleStream =
  config.APP_ENV === 'dev'
    ? (await import('pino-pretty')).default({ colorize: true })
    : process.stdout;

function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: {
        service: 'checkout-bff',
        version: config.SERVICE_VERSION,
        env: config.APP_ENV,
        hostname: os.hostname(),
        pid: process.pid,
      },
      // Emit the level as a readable label ("info") instead of the numeric code (30).
      formatters: {
        level: (label) => ({ level: label }),
      },
      // Never let secrets reach the logs.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          '*.password',
          '*.token',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            requestId: req.id,
            remoteAddress: req.ip,
            userAgent: req.headers['user-agent'],
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
        err: pino.stdSerializers.err,
      },
      mixin() {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
      },
      stream: multistream([
        { level: config.LOG_LEVEL, stream: bffConsoleStream },
        { level: config.LOG_LEVEL, stream: bffOtelStream },
      ]),
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
  // After metricsPlugin so injected 500s are still counted by the onResponse
  // hook (and thus visible to the canary AnalysisRun). No-op unless CHAOS_ERROR_RATE > 0.
  await app.register(chaosPlugin);
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
