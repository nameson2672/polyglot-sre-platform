import { z } from 'zod';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

const ConfigSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  NOTIFIER_WORKER_PORT: z.coerce.number().default(8082),
  WEBHOOK_URL: z.string().default('https://webhook.site/REPLACE-WITH-YOUR-UUID'),
  WEBHOOK_AUTH_TOKEN: z.string().default(''),
  CONSUMER_GROUP: z.string().default('notifier-workers'),
  ENABLE_DLQ: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4317'),
  GIT_COMMIT: z.string().default('unknown'),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config = ConfigSchema.parse(process.env);
export const consumerId = `notifier-${os.hostname()}-${process.pid}`;
export const serviceVersion = pkg.version;
