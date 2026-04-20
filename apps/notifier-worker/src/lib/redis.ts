import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';
import { redisConnected } from './metrics.js';

export function createRedisClient(): Redis {
  const client = new Redis(config.REDIS_URL as string, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  client.on('connect', () => {
    logger.info('Redis connected');
    redisConnected.set(1);
  });

  client.on('ready', () => {
    redisConnected.set(1);
  });

  client.on('error', (err: Error) => {
    logger.error({ err }, 'Redis error');
    redisConnected.set(0);
  });

  client.on('close', () => {
    logger.warn('Redis connection closed');
    redisConnected.set(0);
  });

  return client;
}

export async function createConsumerGroup(
  redis: Redis,
  stream: string,
  group: string,
): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    logger.info({ stream, group }, 'Consumer group created');
  } catch (err) {
    // BUSYGROUP means group already exists — safe to ignore
    if (err instanceof Error && err.message.includes('BUSYGROUP')) {
      logger.debug({ stream, group }, 'Consumer group already exists');
      return;
    }
    throw err;
  }
}

export function parseStreamFields(fields: (string | Buffer)[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    obj[String(fields[i])] = String(fields[i + 1]);
  }
  return obj;
}
