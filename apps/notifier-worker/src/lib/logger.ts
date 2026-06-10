import os from 'node:os';
import { pino, multistream } from 'pino';
import prettyFactory from 'pino-pretty';
import { trace, context } from '@opentelemetry/api';
import { logs, SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';
import { config, consumerId, serviceVersion } from '../config.js';

const otelLogger = logs.getLogger('notifier-worker');

const LABEL_TO_SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

const NUMBER_TO_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

function toSeverity(level: unknown): { number: SeverityNumber; text: string } {
  if (typeof level === 'string') {
    return {
      number: LABEL_TO_SEVERITY[level] ?? SeverityNumber.INFO,
      text: level.toUpperCase(),
    };
  }
  if (typeof level === 'number') {
    return {
      number: NUMBER_TO_SEVERITY[level] ?? SeverityNumber.INFO,
      text: (pino.levels.labels[level] ?? 'info').toUpperCase(),
    };
  }
  return { number: SeverityNumber.INFO, text: 'INFO' };
}

// Pino destination that forwards each record to the OTel Logs SDK. We bridge
// explicitly rather than relying on @opentelemetry/instrumentation-pino because
// pino is imported via top-level ESM here, which links before sdk.start() and so
// is never patched (unlike checkout-bff, where Fastify require()s pino at runtime).
const otelStream = {
  write(line: string): void {
    try {
      const { level, time, msg, ...attrs } = JSON.parse(line) as Record<string, unknown>;
      const severity = toSeverity(level);
      otelLogger.emit({
        timestamp: typeof time === 'number' ? time : Date.now(),
        severityNumber: severity.number,
        severityText: severity.text,
        body: line.trimEnd(),
        attributes: attrs as AnyValueMap,
        context: context.active(), // correlate with active span
      });
    } catch {
      /* non-JSON line — ignore */
    }
  },
};

const consoleStream =
  config.APP_ENV === 'dev' ? prettyFactory({ colorize: true }) : process.stdout;

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: {
      service: 'notifier-worker',
      version: serviceVersion,
      env: config.APP_ENV,
      hostname: os.hostname(),
      pid: process.pid,
      consumer_id: consumerId,
    },
    // Emit the level as a readable label ("info") instead of the numeric code (30).
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Expand Error objects to { type, message, stack } for actionable logs.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    // Never let secrets reach the logs.
    redact: {
      paths: ['*.authorization', '*.token', '*.password', 'webhook_auth_token'],
      censor: '[REDACTED]',
    },
    mixin() {
      const ctx = trace.getActiveSpan()?.spanContext();
      return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
    },
  },
  multistream([
    { level: config.LOG_LEVEL, stream: consoleStream },
    { level: config.LOG_LEVEL, stream: otelStream },
  ]),
);
