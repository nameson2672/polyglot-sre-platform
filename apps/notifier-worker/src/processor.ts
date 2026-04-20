import type { Redis } from 'ioredis';
import { config, consumerId } from './config.js';
import { logger } from './lib/logger.js';
import { eventsConsumedTotal, eventProcessingDuration, dlqEventsTotal } from './lib/metrics.js';
import { startEventSpan, endSpanSuccess, endSpanError, getTraceparentFromSpan } from './lib/tracing.js';
import { callWebhook, WebhookError } from './webhook.js';
import type { NotificationEvent } from './schemas/event.js';

const STREAM = 'orders.events';
const DLQ_STREAM = 'orders.events.dlq';

export async function processEvent(
  redis: Redis,
  messageId: string,
  event: NotificationEvent,
  group: string,
): Promise<void> {
  const start = performance.now();
  const { span } = startEventSpan(event);

  const logFields = {
    event_id: event.event_id,
    event_type: event.event_type,
    order_id: event.order_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
  };

  try {
    const traceparent = getTraceparentFromSpan(span);
    const { attempts } = await callWebhook(event, traceparent);

    await redis.xack(STREAM, group, messageId);

    const durationSec = (performance.now() - start) / 1000;
    eventProcessingDuration.observe({ event_type: event.event_type }, durationSec);
    eventsConsumedTotal.inc({ event_type: event.event_type, status: 'success' });

    logger.info({ ...logFields, attempts, duration_ms: durationSec * 1000 }, 'Event processed');
    endSpanSuccess(span);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // CHAOS: DLQ disabled by default; enable ENABLE_DLQ=true in production
    if (config.ENABLE_DLQ) {
      await redis.xadd(DLQ_STREAM, '*',
        'event_id', event.event_id,
        'event_type', event.event_type,
        'order_id', event.order_id,
        'original_message_id', messageId,
        'consumer_id', consumerId,
        'error', error.message,
        'failed_at', new Date().toISOString(),
        'payload', JSON.stringify(event.payload),
      );
      dlqEventsTotal.inc();
      logger.error({ ...logFields, error: error.message }, 'Event sent to DLQ');
    } else {
      logger.error({ ...logFields, error: error.message }, 'Event failed (DLQ disabled)');
    }

    // ACK so the message doesn't get redelivered — it's already failed permanently
    await redis.xack(STREAM, group, messageId);

    const durationSec = (performance.now() - start) / 1000;
    eventProcessingDuration.observe({ event_type: event.event_type }, durationSec);

    const status =
      err instanceof WebhookError && !err.retryable ? 'webhook_failed' : 'webhook_failed';
    eventsConsumedTotal.inc({ event_type: event.event_type, status });

    endSpanError(span, error);
  }
}
