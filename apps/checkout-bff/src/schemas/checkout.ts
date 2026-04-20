import { z } from 'zod';

export const CheckoutItemSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().min(1),
  unit_price_cents: z.number().int().min(0),
});

export const CheckoutRequestSchema = z.object({
  items: z.array(CheckoutItemSchema).min(1),
  payment_method: z.string().min(1),
  currency: z.string().length(3).default('USD'),
  customer_id: z.string().uuid().optional(),
});

export const CheckoutResponseSchema = z.object({
  checkout_id: z.string(),
  order_id: z.string().uuid(),
  status: z.literal('confirmed'),
  total_cents: z.number(),
});

export const CheckoutSessionSchema = z.object({
  checkout_id: z.string(),
  order_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  status: z.enum(['pending', 'confirmed', 'failed']),
  total_cents: z.number(),
  created_at: z.string(),
});

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
export type CheckoutSession = z.infer<typeof CheckoutSessionSchema>;
