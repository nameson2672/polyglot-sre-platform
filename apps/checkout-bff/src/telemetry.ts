import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'checkout-bff',
  [ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.1.0',
});

const traceExporter = new OTLPTraceExporter({
  url: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317',
});

const metricExporter = new OTLPMetricExporter({
  url: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317',
});

export const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

try {
  sdk.start();
} catch (err) {
  console.warn('[telemetry] OTel SDK failed to start, tracing disabled:', err);
}

process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
  } catch {
    // ignore shutdown errors
  }
});
