import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('undici', () => ({ fetch: vi.fn() }));
vi.mock('../config.js', () => ({
  config: { WEBHOOK_URL: 'https://test.webhook.example/hook', WEBHOOK_AUTH_TOKEN: 'test-token' },
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
  app_info: {},
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { fetch } from 'undici';
import { callWebhook, WebhookError } from '../webhook.js';
import type { NotificationEvent } from '../schemas/event.js';

const mockFetch = vi.mocked(fetch);

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

function makeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe('callWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns on first 200 response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200));
    const result = await callWebhook(baseEvent);
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('includes Authorization and Content-Type headers', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200));
    await callWebhook(baseEvent);
    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('injects traceparent header when provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200));
    await callWebhook(baseEvent, '00-abc-def-01');
    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['traceparent']).toBe('00-abc-def-01');
  });

  it('retries on 500 and succeeds on 2nd attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));
    const result = await callWebhook(baseEvent);
    expect(result.attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 (rate limit)', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200));
    const result = await callWebhook(baseEvent);
    expect(result.attempts).toBe(2);
  });

  it('throws WebhookError without retry on 404', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(404));
    await expect(callWebhook(baseEvent)).rejects.toThrow(WebhookError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws WebhookError without retry on 400', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400));
    await expect(callWebhook(baseEvent)).rejects.toThrow(WebhookError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws after 3 failed attempts on persistent 500', async () => {
    mockFetch.mockResolvedValue(makeResponse(500));
    await expect(callWebhook(baseEvent)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeResponse(200));
    const result = await callWebhook(baseEvent);
    expect(result.attempts).toBe(2);
  });

  it('throws after 3 network errors', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(callWebhook(baseEvent)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
