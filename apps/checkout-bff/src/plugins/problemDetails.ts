import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
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
