import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';

const tracer = trace.getTracer('notifier-worker', '0.1.0');

interface EventContext {
  trace_id: string;
  span_id: string;
  event_id: string;
  event_type: string;
  order_id: string;
}

export function startEventSpan(event: EventContext): { span: Span; ctx: ReturnType<typeof context.active> } {
  // Build W3C traceparent from event fields so this span is a child of the orders-api trace
  const traceparent = `00-${event.trace_id}-${event.span_id}-01`;
  const carrier = { traceparent };

  const parentCtx = propagation.extract(context.active(), carrier);

  const span = tracer.startSpan(
    'notifier.process_event',
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'redis',
        'messaging.destination': 'orders.events',
        'event.id': event.event_id,
        'event.type': event.event_type,
        'order.id': event.order_id,
      },
    },
    parentCtx,
  );

  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

export function endSpanSuccess(span: Span): void {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function endSpanError(span: Span, err: Error): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  span.recordException(err);
  span.end();
}

export function getTraceparentFromSpan(span: Span): string | undefined {
  const ctx = trace.setSpan(context.active(), span);
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier['traceparent'];
}
