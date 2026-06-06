import { pino } from 'pino';
import { trace } from '@opentelemetry/api';
import { config, consumerId } from '../config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: 'notifier-worker',
    consumer_id: consumerId,
  },
  mixin() {
    const ctx = trace.getActiveSpan()?.spanContext();
    return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
  },
});
