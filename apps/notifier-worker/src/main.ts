import { config, consumerId } from './config.js';
import { logger } from './lib/logger.js';
import { createRedisClient, createConsumerGroup } from './lib/redis.js';
import { waitForInflight } from './lib/inflight.js';
import { startConsumer } from './consumer.js';
import { startSidecar } from './sidecar.js';
import { sdk } from './telemetry.js';

const STREAM = 'orders.events';
const MAX_SHUTDOWN_MS = 30_000;

export async function main(): Promise<void> {
  logger.info({ consumer_id: consumerId }, 'notifier-worker starting');

  const redis = createRedisClient();
  let consumerGroupJoined = false;
  const shutdownController = new AbortController();

  // Sidecar starts before Redis so liveness probes respond immediately
  const closeSidecar = await startSidecar(redis, () => consumerGroupJoined);
  logger.info({ port: config.NOTIFIER_WORKER_PORT }, 'Sidecar listening');

  // Connect Redis with backoff — readyz stays 503 until this completes
  await connectWithRetry(redis);

  await createConsumerGroup(redis, STREAM, config.CONSUMER_GROUP);
  consumerGroupJoined = true;
  logger.info({ stream: STREAM, group: config.CONSUMER_GROUP }, 'Consumer group ready');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown signal received');

    const killTimer = setTimeout(() => {
      logger.error('Shutdown timed out — forcing exit');
      process.exit(1);
    }, MAX_SHUTDOWN_MS);
    killTimer.unref();

    // 1. Stop consumer loop
    shutdownController.abort();

    // 2. Wait for in-flight webhook calls to finish (max 10s)
    await waitForInflight(10_000);

    // 3. Close Redis
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }

    // 4. Close sidecar
    await closeSidecar();

    // 5. Flush OTel
    try {
      await sdk.shutdown();
    } catch {
      // Non-fatal: OTel flush failure should not block exit
    }

    logger.info('Shutdown complete');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });

  await startConsumer(redis, config.CONSUMER_GROUP, shutdownController.signal);
  await shutdown();
}

async function connectWithRetry(redis: import('ioredis').Redis): Promise<void> {
  const delays = [500, 1_000, 2_000, 4_000, 8_000];
  for (let attempt = 0; attempt < delays.length + 1; attempt++) {
    try {
      await redis.connect();
      return;
    } catch (err) {
      if (attempt === delays.length) throw new Error('Redis connection failed after all retries');
      const delay = delays[attempt];
      logger.warn({ attempt: attempt + 1, delay_ms: delay, err }, 'Redis connect failed, retrying');
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
