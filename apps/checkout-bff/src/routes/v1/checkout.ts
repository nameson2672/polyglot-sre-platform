import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { ZodError } from 'zod';
import { CheckoutRequestSchema } from '../../schemas/checkout.js';
import { processPayment, PaymentFailedError } from '../../clients/paymentStub.js';
import { createOrder, OrdersApiError } from '../../clients/ordersApi.js';
import { cacheGet, cacheSet } from '../../lib/cache.js';
import { checkoutAttemptsTotal, paymentStubDuration } from '../../lib/metrics.js';
import { Agent } from 'undici';

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/checkout
  app.post('/checkout', async (req: FastifyRequest, reply: FastifyReply) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return reply
        .status(400)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://problems.checkout-bff/missing-idempotency-key',
          title: 'Idempotency-Key header is required',
          status: 400,
          instance: req.url,
        });
    }

    let body: ReturnType<typeof CheckoutRequestSchema.parse>;
    try {
      body = CheckoutRequestSchema.parse(req.body);
    } catch (err) {
      checkoutAttemptsTotal.inc({ outcome: 'validation_error' });
      if (err instanceof ZodError) {
        return reply
          .status(400)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://problems.checkout-bff/validation-error',
            title: 'Validation Error',
            status: 400,
            detail: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
            instance: req.url,
          });
      }
      throw err;
    }

    const customerId = req.customerId ?? body.customer_id;
    if (!customerId) {
      return reply
        .status(401)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://problems.checkout-bff/unauthorized',
          title: 'Missing customer identity',
          status: 401,
          instance: req.url,
        });
    }

    const totalCents = body.items.reduce(
      (sum, item) => sum + item.qty * item.unit_price_cents,
      0,
    );

    // Payment stub
    const payStart = performance.now();
    let paymentResult;
    try {
      paymentResult = await processPayment(totalCents, customerId);
      paymentStubDuration.observe(
        { outcome: 'success' },
        (performance.now() - payStart) / 1000,
      );
    } catch (err) {
      paymentStubDuration.observe(
        { outcome: 'failed' },
        (performance.now() - payStart) / 1000,
      );
      if (err instanceof PaymentFailedError) {
        checkoutAttemptsTotal.inc({ outcome: 'payment_failed' });
        return reply
          .status(402)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://problems.checkout-bff/payment-failed',
            title: 'Payment Failed',
            status: 402,
            detail: err.message,
            instance: req.url,
          });
      }
      throw err;
    }

    // Call orders-api
    const propagationHeaders = {
      traceparent: req.headers['traceparent'] as string | undefined,
      'x-request-id': req.id,
      'idempotency-key': idempotencyKey,
    };

    let order;
    try {
      order = await createOrder(
        {
          customer_id: customerId,
          currency: body.currency,
          items: body.items,
        },
        propagationHeaders,
      );
    } catch (err) {
      if (err instanceof OrdersApiError && err.statusCode >= 500) {
        checkoutAttemptsTotal.inc({ outcome: 'orders_api_error' });
        return reply
          .status(503)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://problems.checkout-bff/upstream-error',
            title: 'Orders service unavailable',
            status: 503,
            detail: 'orders-api returned an error after retries',
            instance: req.url,
          });
      }
      throw err;
    }

    const checkoutId = randomUUID();
    const session = {
      checkout_id: checkoutId,
      order_id: order.id,
      customer_id: customerId,
      status: 'confirmed',
      total_cents: totalCents,
      created_at: new Date().toISOString(),
      payment_transaction_id: paymentResult.transactionId,
    };

    await cacheSet(`checkout:${checkoutId}`, JSON.stringify(session), 3600);

    checkoutAttemptsTotal.inc({ outcome: 'success' });
    req.log.info({ customer_id: customerId, order_id: order.id }, 'Checkout completed');

    return reply.status(201).send({
      checkout_id: checkoutId,
      order_id: order.id,
      status: 'confirmed',
      total_cents: totalCents,
    });
  });

  // GET /v1/checkout/:sessionId
  app.get(
    '/checkout/:sessionId',
    async (
      req: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = req.params;
      const cached = await cacheGet(`checkout:${sessionId}`);
      if (!cached) {
        return reply
          .status(404)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://problems.checkout-bff/not-found',
            title: 'Checkout session not found',
            status: 404,
            instance: req.url,
          });
      }
      return reply.send(JSON.parse(cached));
    },
  );

  // POST /v1/checkout/:sessionId/confirm
  app.post(
    '/checkout/:sessionId/confirm',
    async (
      req: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = req.params;
      const cached = await cacheGet(`checkout:${sessionId}`);
      if (!cached) {
        return reply
          .status(404)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://problems.checkout-bff/not-found',
            title: 'Checkout session not found',
            status: 404,
            instance: req.url,
          });
      }
      const session = JSON.parse(cached) as Record<string, unknown>;
      session['status'] = 'confirmed';
      await cacheSet(`checkout:${sessionId}`, JSON.stringify(session), 3600);
      return reply.send(session);
    },
  );

  // CHAOS: GET /v1/checkout/leak — creates new undici.Agent per call without closing (fd leak)
  app.get('/checkout/leak', async (_req, reply) => {
    // CHAOS: new Agent created per request, never closed — demonstrates fd leak
    const leakyAgent = new Agent({ connections: 10 });
    const { body } = await leakyAgent.request({
      origin: 'http://localhost:8080',
      path: '/healthz',
      method: 'GET',
    });
    await body.text();
    // Agent is never closed — intentional fd leak demo
    return reply.send({ status: 'leaked', message: 'Agent created but not closed' });
  });
}
