import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import { config, consumerId, serviceVersion } from './config.js';
import { registry, heartbeatAgeGauge } from './lib/metrics.js';
import { isHeartbeatHealthy, heartbeatAgeMs } from './lib/heartbeat.js';

export function buildSidecar(redis: Redis, isReady: () => boolean) {
  const app = Fastify({ logger: false });

  app.get('/healthz', async (_req, reply) => {
    heartbeatAgeGauge.set(heartbeatAgeMs() / 1000);
    if (!isHeartbeatHealthy()) {
      return reply.code(503).send({ status: 'unhealthy', reason: 'heartbeat_stale' });
    }
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_req, reply) => {
    const redisOk = redis.status === 'ready';
    const ready = redisOk && isReady();
    if (!ready) {
      return reply
        .code(503)
        .send({ status: 'not_ready', redis: redisOk, consumer_group_joined: isReady() });
    }
    return reply.code(200).send({ status: 'ready' });
  });

  app.get('/info', async (_req, reply) => {
    return reply.code(200).send({
      service: 'notifier-worker',
      version: serviceVersion,
      commit: config.GIT_COMMIT,
      consumer_id: consumerId,
      consumer_group: config.CONSUMER_GROUP,
      node_version: process.version,
    });
  });

  app.get('/metrics', async (_req, reply) => {
    heartbeatAgeGauge.set(heartbeatAgeMs() / 1000);
    const metrics = await registry.metrics();
    return reply.type(registry.contentType).send(metrics);
  });

  return app;
}

export async function startSidecar(redis: Redis, isReady: () => boolean): Promise<() => Promise<void>> {
  const app = buildSidecar(redis, isReady);
  await app.listen({ port: config.NOTIFIER_WORKER_PORT, host: '0.0.0.0' });
  return () => app.close();
}
