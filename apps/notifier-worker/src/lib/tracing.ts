import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';

const tracer = trace.getTracer('notifier-worker', '0.1.0');

// W3C trace-context id formats. Guards against empty/invalid ids carried by stale
// outbox events (which would otherwise produce an invalid traceparent like "00---01").
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

interface EventContext {
  trace_id: string;
  span_id: string;
  event_id: string;
  event_type: string;
  order_id: string;
}

export function startEventSpan(event: EventContext): { span: Span; ctx: ReturnType<typeof context.active> } {
  // Link this span to the orders-api trace when the incoming ids are valid;
  // otherwise start a clean root span.
  let parentCtx = context.active();
  if (TRACE_ID_RE.test(event.trace_id) && SPAN_ID_RE.test(event.span_id)) {
    const carrier = { traceparent: `00-${event.trace_id}-${event.span_id}-01` };
    parentCtx = propagation.extract(context.active(), carrier);
  }

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
