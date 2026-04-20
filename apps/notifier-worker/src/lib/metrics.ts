import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { config, consumerId, serviceVersion } from '../config.js';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const eventsConsumedTotal = new Counter({
  name: 'notifier_events_consumed_total',
  help: 'Total events consumed from Redis stream',
  labelNames: ['event_type', 'status'] as const,
  registers: [registry],
});

export const eventProcessingDuration = new Histogram({
  name: 'notifier_event_processing_duration_seconds',
  help: 'End-to-end event processing duration in seconds',
  labelNames: ['event_type'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const webhookDuration = new Histogram({
  name: 'notifier_webhook_duration_seconds',
  help: 'Webhook call duration in seconds',
  labelNames: ['status_code'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
  registers: [registry],
});

export const consumerLag = new Gauge({
  name: 'notifier_consumer_lag',
  help: 'Number of pending (unacknowledged) messages in the consumer group',
  registers: [registry],
});

export const redisConnected = new Gauge({
  name: 'notifier_redis_connected',
  help: 'Redis connection status (1=connected, 0=disconnected)',
  registers: [registry],
});

export const inflightEvents = new Gauge({
  name: 'notifier_inflight_events',
  help: 'Number of events currently being processed',
  registers: [registry],
});

export const heartbeatAgeGauge = new Gauge({
  name: 'notifier_heartbeat_age_seconds',
  help: 'Seconds since last consumer loop heartbeat',
  registers: [registry],
});

export const dlqEventsTotal = new Counter({
  name: 'notifier_dlq_events_total',
  help: 'Total events sent to the dead-letter queue',
  registers: [registry],
});

new Gauge({
  name: 'app_info',
  help: 'Static application metadata',
  labelNames: ['version', 'commit', 'service', 'consumer_id'] as const,
  registers: [registry],
}).set(
  {
    version: serviceVersion,
    commit: config.GIT_COMMIT,
    service: 'notifier-worker',
    consumer_id: consumerId,
  },
  1,
);
