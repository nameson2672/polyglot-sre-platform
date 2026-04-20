import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockXack = vi.fn().mockResolvedValue(1);
const mockXadd = vi.fn().mockResolvedValue('0-1');

vi.mock('../config.js', () => ({
  config: {
    WEBHOOK_URL: 'https://test.webhook.example/hook',
    WEBHOOK_AUTH_TOKEN: 'tok',
    CONSUMER_GROUP: 'notifier-workers',
    ENABLE_DLQ: true,
    GIT_COMMIT: 'abc',
  },
  consumerId: 'notifier-test-1',
  serviceVersion: '0.1.0',
}));

vi.mock('../lib/metrics.js', () => ({
  webhookDuration: { observe: vi.fn() },
  eventsConsumedTotal: { inc: vi.fn() },
  eventProcessingDuration: { observe: vi.fn() },
  dlqEventsTotal: { inc: vi.fn() },
  inflightEvents: { inc: vi.fn(), dec: vi.fn() },
  consumerLag: { set: vi.fn() },
  redisConnected: { set: vi.fn() },
  heartbeatAgeGauge: { set: vi.fn() },
  registry: { metrics: vi.fn(), contentType: 'text/plain' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../lib/tracing.js', () => ({
  startEventSpan: vi.fn(() => ({
    span: {
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    },
    ctx: {},
  })),
  endSpanSuccess: vi.fn(),
  endSpanError: vi.fn(),
  getTraceparentFromSpan: vi.fn(() => '00-trace-span-01'),
}));

vi.mock('../webhook.js', () => ({
  callWebhook: vi.fn(),
  WebhookError: class WebhookError extends Error {
    constructor(msg: string, public statusCode: number | null, public retryable: boolean) {
      super(msg);
      this.name = 'WebhookError';
    }
  },
}));

import { processEvent } from '../processor.js';
import { callWebhook } from '../webhook.js';
import { eventsConsumedTotal, dlqEventsTotal, eventProcessingDuration } from '../lib/metrics.js';
import type { NotificationEvent } from '../schemas/event.js';

const mockCallWebhook = vi.mocked(callWebhook);
const mockEventsConsumedTotal = vi.mocked(eventsConsumedTotal);
const mockDlqEventsTotal = vi.mocked(dlqEventsTotal);
const mockEventProcessingDuration = vi.mocked(eventProcessingDuration);

const fakeRedis = {
  xack: mockXack,
  xadd: mockXadd,
} as unknown as import('ioredis').default;

const baseEvent: NotificationEvent = {
  event_id: '11111111-1111-1111-1111-111111111111',
  event_type: 'order.confirmed',
  order_id: '22222222-2222-2222-2222-222222222222',
  customer_id: '33333333-3333-3333-3333-333333333333',
  occurred_at: '2026-01-01T00:00:00Z',
  trace_id: '0af7651916cd43dd8448eb211c80319c',
  span_id: 'b7ad6b7169203331',
  payload: { total_cents: 1000, currency: 'CAD' },
};

describe('processEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ACKs the message on webhook success', async () => {
    mockCallWebhook.mockResolvedValueOnce({ attempts: 1 });
    await processEvent(fakeRedis, 'msg-001', baseEvent, 'notifier-workers');
    expect(mockXack).toHaveBeenCalledWith('orders.events', 'notifier-workers', 'msg-001');
  });

  it('records success metric after successful processing', async () => {
    mockCallWebhook.mockResolvedValueOnce({ attempts: 1 });
    await processEvent(fakeRedis, 'msg-001', baseEvent, 'notifier-workers');
    expect(mockEventsConsumedTotal.inc).toHaveBeenCalledWith({
      event_type: 'order.confirmed',
      status: 'success',
    });
  });

  it('records processing duration histogram', async () => {
    mockCallWebhook.mockResolvedValueOnce({ attempts: 2 });
    await processEvent(fakeRedis, 'msg-001', baseEvent, 'notifier-workers');
    expect(mockEventProcessingDuration.observe).toHaveBeenCalledWith(
      { event_type: 'order.confirmed' },
      expect.any(Number),
    );
  });

  it('sends event to DLQ when webhook fails after 3 retries', async () => {
    mockCallWebhook.mockRejectedValueOnce(new Error('max retries exceeded'));
    await processEvent(fakeRedis, 'msg-002', baseEvent, 'notifier-workers');
    expect(mockXadd).toHaveBeenCalled();
    const [stream, id, ...fields] = mockXadd.mock.calls[0] as string[];
    expect(stream).toBe('orders.events.dlq');
    expect(id).toBe('*');
    const fieldMap: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];
    expect(fieldMap['event_id']).toBe(baseEvent.event_id);
    expect(fieldMap['error']).toBe('max retries exceeded');
    expect(fieldMap['original_message_id']).toBe('msg-002');
    expect(mockDlqEventsTotal.inc).toHaveBeenCalled();
  });

  it('ACKs the message even when webhook fails (to avoid infinite redelivery)', async () => {
    mockCallWebhook.mockRejectedValueOnce(new Error('all retries exhausted'));
    await processEvent(fakeRedis, 'msg-003', baseEvent, 'notifier-workers');
    expect(mockXack).toHaveBeenCalledWith('orders.events', 'notifier-workers', 'msg-003');
  });

  it('records failure metric when webhook fails', async () => {
    mockCallWebhook.mockRejectedValueOnce(new Error('500'));
    await processEvent(fakeRedis, 'msg-004', baseEvent, 'notifier-workers');
    expect(mockEventsConsumedTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'webhook_failed' }),
    );
  });

  it('succeeds when webhook needs 2 attempts', async () => {
    mockCallWebhook.mockResolvedValueOnce({ attempts: 2 });
    await processEvent(fakeRedis, 'msg-005', baseEvent, 'notifier-workers');
    expect(mockXack).toHaveBeenCalled();
    expect(mockEventsConsumedTotal.inc).toHaveBeenCalledWith({
      event_type: 'order.confirmed',
      status: 'success',
    });
  });
});
