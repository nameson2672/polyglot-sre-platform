import { Redis } from 'ioredis';
import { config } from '../config.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    _redis.on('error', (err: Error) => {
      console.error('[redis] connection error:', err.message);
    });
  }
  return _redis;
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await getRedis().get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().setex(key, ttlSeconds, value);
  } catch {
    // swallow — cache is best-effort
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch {
    // swallow
  }
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
