import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'notifier-worker',
  [ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? pkg.version,
});

const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317';

const traceExporter = new OTLPTraceExporter({ url: otlpEndpoint });
const metricExporter = new OTLPMetricExporter({ url: otlpEndpoint });
const logExporter = new OTLPLogExporter({ url: otlpEndpoint });

export const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 10_000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      // Logs are bridged explicitly in lib/logger.ts (top-level ESM pino import is
      // never patched by this instrumentation), so disable it to avoid double-emit.
      '@opentelemetry/instrumentation-pino': { enabled: false },
    }),
  ],
});

if (process.env['NODE_ENV'] !== 'test') {
  try {
    sdk.start();
  } catch (err) {
    console.warn('[telemetry] OTel SDK failed to start, tracing disabled:', err);
  }
}
