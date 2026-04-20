import { z } from 'zod';

const ConfigSchema = z.object({
  APP_ENV: z.string().default('dev'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CHECKOUT_BFF_PORT: z.coerce.number().default(8081),
  ORDERS_API_URL: z.string().url(),
  ORDERS_API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PAYMENT_STUB_LATENCY_MS: z.coerce.number().default(300),
  PAYMENT_STUB_FAILURE_RATE: z.coerce.number().default(0.02),
  PAYMENT_STUB_LATENCY_JITTER_MS: z.coerce.number().default(0),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4317'),
  SERVICE_VERSION: z.string().default('0.1.0'),
  SERVICE_COMMIT: z.string().default('unknown'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
