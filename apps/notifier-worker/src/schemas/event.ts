import { z } from 'zod';

export const EventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.enum(['order.created', 'order.confirmed', 'order.cancelled', 'order.shipped']),
  order_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  // orders-api emits DateTimeOffset.ToString("O") which carries a +00:00 offset,
  // so offsets must be permitted (zod rejects them by default).
  occurred_at: z.string().datetime({ offset: true }),
  trace_id: z.string(),
  span_id: z.string(),
  // CHAOS: JSON.parse is synchronous; large payloads block the event loop
  payload: z.string().transform((s) => JSON.parse(s) as unknown),
});

export type NotificationEvent = z.infer<typeof EventSchema>;
