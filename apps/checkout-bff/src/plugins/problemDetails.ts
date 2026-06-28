import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ZodError } from 'zod';

export async function problemDetailsPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(
    async (error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
      req.log.error({ err: error }, 'Request error');

      if (error instanceof ZodError) {
        return reply
          .status(400)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://problems.checkout-bff/validation-error',
            title: 'Validation Error',
            status: 400,
            detail: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
            instance: req.url,
          });
      }

      const statusCode = (error as FastifyError).statusCode ?? 500;

      // Mark the request span errored on genuine server errors (5xx) so the failing
      // request shows red in Tempo with the stack trace attached. Client errors
      // (validation 400s above) deliberately leave the span clean.
      if (statusCode >= 500) {
        const span = trace.getActiveSpan();
        span?.recordException(error);
        span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }

      return reply
        .status(statusCode)
        .header('content-type', 'application/problem+json')
        .send({
          type: `https://problems.checkout-bff/${statusCode}`,
          title: error.message || 'Internal Server Error',
          status: statusCode,
          instance: req.url,
        });
    },
  );
}
