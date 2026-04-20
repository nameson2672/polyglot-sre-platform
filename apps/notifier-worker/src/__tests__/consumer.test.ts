import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockXack = vi.fn().mockResolvedValue(1);
const mockXadd = vi.fn().mockResolvedValue('0-1');
const mockXpending = vi.fn().mockResolvedValue([0, null, null, []]);

vi.mock('../config.js', () => ({
  config: {
    CONSUMER_GROUP: 'notifier-workers',
    ENABLE_DLQ: false,
  },
  consumerId: 'notifier-test-1',
  serviceVersion: '0.1.0',
}));

vi.mock('../lib/metrics.js', () => ({
  eventsConsumedTotal: { inc: vi.fn() },
  consumerLag: { set: vi.fn() },
  inflightEvents: { inc: vi.fn(), dec: vi.fn() },
  redisConnected: { set: vi.fn() },
  heartbeatAgeGauge: { set: vi.fn() },
  webhookDuration: { observe: vi.fn() },
  eventProcessingDuration: { observe: vi.fn() },
  dlqEventsTotal: { inc: vi.fn() },
  registry: { metrics: vi.fn(), contentType: 'text/plain' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../lib/inflight.js', () => ({
  incInflight: vi.fn(),
  decInflight: vi.fn(),
  waitForInflight: vi.fn(),
}));

vi.mock('../processor.js', () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}));

import { startConsumer } from '../consumer.js';
import { processEvent } from '../processor.js';
import { eventsConsumedTotal } from '../lib/metrics.js';
import { updateHeartbeat, isHeartbeatHealthy } from '../lib/heartbeat.js';

const mockProcessEvent = vi.mocked(processEvent);

function makeRedis(responses: unknown[]): import('ioredis').default {
  let callCount = 0;
  return {
    xreadgroup: (..._args: unknown[]) => {
      const resp = responses[callCount++];
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    },
    xack: mockXack,
    xadd: mockXadd,
    xpending: mockXpending,
    xclaim: vi.fn().mockResolvedValue([]),
    status: 'ready',
  } as unknown as import('ioredis').default;
}

function makeStreamResult(fields: Record<string, string>) {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) flat.push(k, v);
  return [['orders.events', [['1234-0', flat]]]];
}

const validEventFields = {
  event_id: '11111111-1111-1111-1111-111111111111',
  event_type: 'order.confirmed',
  order_id: '22222222-2222-2222-2222-222222222222',
  customer_id: '33333333-3333-3333-3333-333333333333',
  occurred_at: '2026-01-01T00:00:00.000Z',
  trace_id: '0af7651916cd43dd8448eb211c80319c',
  span_id: 'b7ad6b7169203331',
  payload: JSON.stringify({ total_cents: 1000 }),
};

describe('startConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset heartbeat to now
    updateHeartbeat();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('processes a valid event and calls processEvent', async () => {
    const ctrl = new AbortController();
    const redis = makeRedis([
      makeStreamResult(validEventFields),
      null, // second iteration returns nothing → we abort
    ]);

    mockProcessEvent.mockImplementationOnce(async () => {
      ctrl.abort();
    });

    await startConsumer(redis, 'notifier-workers', ctrl.signal);
    expect(mockProcessEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessEvent.mock.calls[0][2]).toMatchObject({
      event_id: validEventFields.event_id,
      event_type: 'order.confirmed',
    });
  });

  it('ACKs and increments invalid metric for malformed event schema', async () => {
    const ctrl = new AbortController();
    const invalidFields = { ...validEventFields, event_id: 'not-a-uuid' };
    const redis = makeRedis([makeStreamResult(invalidFields), null]);

    // abort after first batch
    const origXack = mockXack;
    mockXack.mockImplementationOnce(async (...args: unknown[]) => {
      ctrl.abort();
      return origXack(...args);
    });

    await startConsumer(redis, 'notifier-workers', ctrl.signal);
    expect(mockXack).toHaveBeenCalledWith('orders.events', 'notifier-workers', '1234-0');
    expect(vi.mocked(eventsConsumedTotal).inc).toHaveBeenCalledWith({
      event_type: 'unknown',
      status: 'invalid',
    });
    expect(mockProcessEvent).not.toHaveBeenCalled();
  });

  it('stops loop when abort signal fires', async () => {
    const ctrl = new AbortController();
    const redis = makeRedis([null, null, null]);
    ctrl.abort();
    await startConsumer(redis, 'notifier-workers', ctrl.signal);
    // Should exit immediately without processing
    expect(mockProcessEvent).not.toHaveBeenCalled();
  });

  it('updates heartbeat after each iteration with messages', async () => {
    const ctrl = new AbortController();
    const redis = makeRedis([makeStreamResult(validEventFields), null]);

    mockProcessEvent.mockImplementationOnce(async () => {
      ctrl.abort();
    });

    const before = Date.now();
    await startConsumer(redis, 'notifier-workers', ctrl.signal);
    expect(isHeartbeatHealthy()).toBe(true);
    expect(Date.now() - before).toBeLessThan(5_000);
  });

  it('recovers from XREADGROUP errors without crashing', async () => {
    const ctrl = new AbortController();
    let callCount = 0;
    const redis = {
      xreadgroup: () => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('Redis connection lost'));
        ctrl.abort();
        return Promise.resolve(null);
      },
      xack: mockXack,
      xadd: mockXadd,
      xpending: mockXpending,
      xclaim: vi.fn(),
      status: 'ready',
    } as unknown as import('ioredis').default;

    await startConsumer(redis, 'notifier-workers', ctrl.signal);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

describe('heartbeat', () => {
  it('is healthy immediately after update', () => {
    updateHeartbeat();
    expect(isHeartbeatHealthy()).toBe(true);
  });

  it('is unhealthy when heartbeat age exceeds threshold', () => {
    // Simulate stale heartbeat by checking with a very short maxAge
    expect(isHeartbeatHealthy(0)).toBe(false);
  });
});
