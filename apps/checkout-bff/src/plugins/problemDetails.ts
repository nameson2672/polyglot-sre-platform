import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ZodError } from 'zod';

export async function problemDetailsPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(
    async (error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
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

      // Only genuine server errors (5xx) are worth an error log — with the stack.
      // Client errors (validation/4xx) are deliberately not error-logged to keep
      // the logs to actionable events; the requestLog hook records them at warn.
      if (statusCode >= 500) {
        req.log.error({ err: error }, 'Unhandled exception');
        // Mark the request span errored so it shows red in Tempo with the stack.
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
