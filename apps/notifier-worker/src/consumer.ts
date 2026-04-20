import type { Redis } from 'ioredis';
import { consumerId } from './config.js';
import { logger } from './lib/logger.js';
import { parseStreamFields } from './lib/redis.js';
import { updateHeartbeat } from './lib/heartbeat.js';
import { incInflight, decInflight } from './lib/inflight.js';
import { consumerLag, eventsConsumedTotal } from './lib/metrics.js';
import { processEvent } from './processor.js';
import { EventSchema } from './schemas/event.js';

const STREAM = 'orders.events';
const BLOCK_MS = 5_000;
const COUNT = 10;
const RECLAIM_INTERVAL_MS = 30_000;
const STALE_IDLE_MS = 60_000;
const LAG_POLL_INTERVAL_MS = 5_000;

type RawMessages = Array<[id: string | Buffer, fields: (string | Buffer)[]]>;
type XReadGroupResult = Array<[streamName: string | Buffer, messages: RawMessages]> | null;

export async function startConsumer(
  redis: Redis,
  group: string,
  shutdownSignal: AbortSignal,
): Promise<void> {
  let lastReclaim = Date.now();

  const lagInterval = setInterval(() => {
    void redis
      .xpending(STREAM, group)
      .then((pending: unknown) => {
        if (Array.isArray(pending) && typeof pending[0] === 'number') {
          consumerLag.set(pending[0] as number);
        }
      })
      .catch(() => {
        // Non-fatal: lag metric may be stale
      });
  }, LAG_POLL_INTERVAL_MS);

  try {
    while (!shutdownSignal.aborted) {
      if (Date.now() - lastReclaim >= RECLAIM_INTERVAL_MS) {
        await reclaimStale(redis, group);
        lastReclaim = Date.now();
      }

      let result: XReadGroupResult;
      try {
        result = (await redis.xreadgroup(
          'GROUP',
          group,
          consumerId,
          'COUNT',
          String(COUNT),
          'BLOCK',
          String(BLOCK_MS),
          'STREAMS',
          STREAM,
          '>',
        )) as XReadGroupResult;
      } catch (err) {
        if (shutdownSignal.aborted) break;
        logger.error({ err }, 'XREADGROUP error — backing off');
        await sleep(1_000);
        continue;
      }

      updateHeartbeat();

      if (!result || result.length === 0) continue;

      const [, messages] = result[0];
      if (!messages || messages.length === 0) continue;

      const processing: Promise<void>[] = [];

      for (const [rawId, rawFields] of messages) {
        const messageId = String(rawId);
        const fields = parseStreamFields(rawFields);

        const parsed = EventSchema.safeParse(fields);
        if (!parsed.success) {
          logger.error(
            { message_id: messageId, error: parsed.error.message },
            'Invalid event schema — discarding',
          );
          eventsConsumedTotal.inc({ event_type: 'unknown', status: 'invalid' });
          await redis.xack(STREAM, group, messageId);
          continue;
        }

        incInflight();
        const p = processEvent(redis, messageId, parsed.data, group).finally(() => {
          decInflight();
        });
        processing.push(p);
      }

      await Promise.allSettled(processing);
    }
  } finally {
    clearInterval(lagInterval);
    logger.info('Consumer loop exited');
  }
}

async function reclaimStale(redis: import('ioredis').Redis, group: string): Promise<void> {
  try {
    const pending = (await redis.xpending(STREAM, group, '-', '+', 10)) as Array<
      [string, string, number, number]
    >;

    for (const [id, , idleMs] of pending) {
      if (idleMs > STALE_IDLE_MS) {
        await redis.xclaim(STREAM, group, consumerId, STALE_IDLE_MS, id);
        logger.warn({ message_id: id, idle_ms: idleMs }, 'Reclaimed stale pending message');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Stale message reclaim failed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
