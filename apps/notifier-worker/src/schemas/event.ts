import { z } from 'zod';

export const EventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.enum(['order.confirmed', 'order.cancelled', 'order.shipped']),
  order_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  occurred_at: z.string().datetime(),
  trace_id: z.string(),
  span_id: z.string(),
  // CHAOS: JSON.parse is synchronous; large payloads block the event loop
  payload: z.string().transform((s) => JSON.parse(s) as unknown),
});

export type NotificationEvent = z.infer<typeof EventSchema>;
